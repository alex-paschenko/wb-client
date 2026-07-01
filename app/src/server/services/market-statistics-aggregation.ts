import { SERVER_EVENT } from '../constants/events.js';
import {
  MARKET_STATISTICS_LEVEL_CONFIGS
} from '../../shared/constants/market-statistics-config.js';
import { eventBus } from './event-bus.js';

import type {
  MarketCandle,
  MarketSnapshot,
  MarketStatisticsItem,
} from '../../shared/types/market-statistics-storage.js';
import {
  MarketStatisticsStorageService
} from '../../shared/services/market-statistics-storage.js';
import type {
  MarketTickReceivedEvent,
  MarketStatisticsPersistenceChange,
  MarketStatisticsRestoredEvent,
} from '../types/events.js';
import { SECOND } from '../../shared/constants/time.js';
import { MarketTick } from '../types/market-statistics.js';

export class MarketStatisticsAggregationService {
  private readonly storagesByMarket = new Map<
    string,
    MarketStatisticsStorageService
  >();

  start(): void {
    eventBus.on(
      SERVER_EVENT.marketTickReceived,
      (event) => this.handleTickReceived(event),
    );

    eventBus.on(
      SERVER_EVENT.marketStatisticsRestored,
      (event) => this.handleMarketStatisticsRestored(event),
    );

    eventBus.on(
      SERVER_EVENT.freezeOnStatisticsStorageNeedsToBeLowered,
      (event) => this.handleFreezeOnStatisticsStorageNeedsToBeLowered(event.marketName),
    );

    // TODO Remove it! For testing purpose only!
    const stor = this.storagesByMarket;
    setInterval(() => {
      let marketName = '---'; let numOfPoints = 0;
      for (const [k, v] of stor.entries()) {
        const nop = v.size(0);
        if (nop > numOfPoints) {
          numOfPoints = nop;
          marketName = k;
        }
      }
      console.log(`Most active market: ${marketName} (${numOfPoints})`);
    }, 30000)
  }

  public createFullSyncSnapshot(
    marketName: string,
  ): MarketStatisticsItem[][] {
    this.incrementFreezing(marketName);

    const storage = this.getOrCreateStorage(marketName);

    return storage.getAllItemsByLevel();
  }

  public getStorageItemsByMarket(): Record<string, MarketStatisticsItem[][]> {
    return Object.fromEntries(
      [...this.storagesByMarket.entries()].map(([marketName, storage]) => [
        marketName,
        storage.getAllItemsByLevel(),
      ]),
    );
  }

  private readonly freezingByMarket = new Map<string, number>();

  private readonly tickBuffersByMarket = new Map<string, MarketTick[]>();

  private tickToSnapshot(
    storage: MarketStatisticsStorageService,
    newTick: MarketTick,
  ): MarketSnapshot {
    const previousTick = storage.getLastItem(0);

    return {
      ...newTick,
      speed: this.calculateSpeed(previousTick, newTick),
    };
  }

  private handleTickReceived(
    event: MarketTickReceivedEvent,
  ): void {
    const buffer = this.getTickBuffer(event.marketName);

    if (
      this.isFrozen(event.marketName) ||
      buffer.length > 0
    ) {
      buffer.push(event.tick);
      return;
    }

    this.tickProcessor(event.marketName, event.tick);
  }

  private tickProcessor(
    marketName: string,
    tick: MarketTick,
  ): void {
    const storage = this.getOrCreateStorage(marketName);
    const snapshot = this.tickToSnapshot(storage, tick);

    const previousTick = storage.getLastItem(0);
    if (previousTick?.receivedAt === snapshot.receivedAt) {
      console.warn('Duplicate tick received', snapshot);
      return;
    }

    storage.addItem(0, snapshot, 'should record delta');

    const addedItems: MarketStatisticsItem[] = [snapshot];

    this.aggregate(storage, addedItems);

    const delta = storage.commitDelta();

    if (delta) {
      eventBus.emit(SERVER_EVENT.marketStatisticsStorageChanged, {
        marketName,
        delta,
      });
    }

    eventBus.emit(SERVER_EVENT.marketStatisticsPersistenceChanged, {
      marketName,
      changes: this.toPersistenceChanges(storage, addedItems),
    });

    eventBus.emit(SERVER_EVENT.marketStatisticsViewUpdated, {
      marketName,
      createItems: (direction) => storage.createItems(direction),
    });
  }

  private aggregate(
    storage: MarketStatisticsStorageService,
    addedItems: MarketStatisticsItem[],
  ): void {
    for (
      let level = 0;
      level < MARKET_STATISTICS_LEVEL_CONFIGS.length - 1;
      level++
    ) {
      const currentConfig = MARKET_STATISTICS_LEVEL_CONFIGS[level];
      const nextConfig = MARKET_STATISTICS_LEVEL_CONFIGS[level + 1];

      const startedAt = storage.getStartedAt(level);
      const endedAt = storage.getEndedAt(level);

      if (startedAt === null || endedAt === null) {
        return;
      }

      if (
        endedAt - startedAt <=
        currentConfig.interval + nextConfig.duration
      ) {
        return;
      }

      const cutoff = endedAt - currentConfig.interval;
      const items = storage.readItemsBefore(level, cutoff);

      if (items.length === 0) {
        return;
      }

      const candle = currentConfig.sourceType === 'snapshot'
        ? this.aggregateSnapshots(items as MarketSnapshot[])
        : this.aggregateCandles(items as MarketCandle[]);

      storage.removeNItems(
        level,
        items.length,
        'should record delta',
      );

      storage.addItem(
        level + 1,
        candle,
        'should record delta',
      );

      addedItems.push(candle);
    }
  }

  private calculateSpeed(
    previous: MarketTick | null,
    current: MarketTick,
  ): number {
    if (!previous) {
      return 0;
    }

    const seconds =
      (current.receivedAt - previous.receivedAt) / SECOND;

    if (seconds <= 0) {
      return 0;
    }

    return (current.price - previous.price) / seconds;
  }

  private toPersistenceChanges(
    storage: MarketStatisticsStorageService,
    addedItems: MarketStatisticsItem[],
  ): MarketStatisticsPersistenceChange[] {
    return addedItems.map((item, level) => {
      const deleteBefore = storage.getStartedAt(level);

      if (deleteBefore === null) {
        throw new Error(
          `Market statistics level ${level} is empty after adding item.`,
        );
      }

      return {
        item,
        deleteBefore,
      };
    });
  }

  private aggregateSnapshots(
    snapshots: MarketSnapshot[],
  ): MarketCandle {
    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];

    let high = first.price;
    let low = first.price;

    for (const snapshot of snapshots) {
      high = Math.max(high, snapshot.price);
      low = Math.min(low, snapshot.price);
    }

    const startedAt = first.receivedAt;
    const endedAt = last.receivedAt;
    const receivedAt = this.getMiddleTimestamp(startedAt, endedAt);

    const open = first.price;
    const close = last.price;

    return {
      receivedAt,
      price: this.calculateCandlePrice(open, close, high, low),
      speed: this.calculateSpeed(first, last),

      startedAt,
      endedAt,

      open,
      close,
      high,
      low,
    };
  }

  private aggregateCandles(
    candles: MarketCandle[],
  ): MarketCandle {
    const first = candles[0];
    const last = candles[candles.length - 1];

    let high = first.high;
    let low = first.low;

    for (const candle of candles) {
      high = Math.max(high, candle.high);
      low = Math.min(low, candle.low);
    }

    const startedAt = first.startedAt;
    const endedAt = last.endedAt;
    const receivedAt = this.getMiddleTimestamp(startedAt, endedAt);

    const open = first.open;
    const close = last.close;

    return {
      receivedAt,
      price: this.calculateCandlePrice(open, close, high, low),
      speed: this.calculateSpeed(first, last),

      startedAt,
      endedAt,

      open,
      close,
      high,
      low,
    };
  }

  private getOrCreateStorage(
    marketName: string,
  ): MarketStatisticsStorageService {
    const existing = this.storagesByMarket.get(marketName);

    if (existing) {
      return existing;
    }

    const created = new MarketStatisticsStorageService(marketName);
    this.storagesByMarket.set(marketName, created);

    return created;
  }

  private handleMarketStatisticsRestored(
    event: MarketStatisticsRestoredEvent,
  ): void {
    for (const [marketName, data] of Object.entries(event.itemsByMarket)) {
      const storage = this.getOrCreateStorage(marketName);

      for (const snapshot of data.snapshots) {
        storage.addItem(0, snapshot, 'suppress record delta');
      }

      for (const [stringLevel, candles] of Object.entries(data.candlesByLevel)) {

        for (const candle of candles) {
          storage.addItem(
            Number(stringLevel),
            candle,
            'suppress record delta',
          );
        }
      }

      storage.commitDelta();
    }
  }

  private calculateCandlePrice(
    open: number,
    close: number,
    high: number,
    low: number,
  ): number {
    return (open + close + high + low) / 4;
  }

  private getMiddleTimestamp(
    startedAt: number,
    endedAt: number,
  ): number {
    return Math.round(startedAt + (endedAt - startedAt) / 2);
  }

  private incrementFreezing(marketName: string): void {
    this.freezingByMarket.set(
      marketName,
      (this.freezingByMarket.get(marketName) ?? 0) + 1,
    );
  }

  private handleFreezeOnStatisticsStorageNeedsToBeLowered(
    marketName: string
  ): void {
    const current = this.freezingByMarket.get(marketName) ?? 0;

    if (current <= 1) {
      this.freezingByMarket.delete(marketName);
      this.flushTickBuffer(marketName);
      return;
    }

    this.freezingByMarket.set(marketName, current - 1);
  }

  private flushTickBuffer(marketName: string): void {
    if (this.isFrozen(marketName)) {
      return;
    }

    const buffer = this.getTickBuffer(marketName);

    while (buffer.length > 0 && !this.isFrozen(marketName)) {
      const tick = buffer.shift();

      if (!tick) {
        return;
      }

      this.tickProcessor(marketName, tick);
    }
  }

  private isFrozen(marketName: string): boolean {
    return (this.freezingByMarket.get(marketName) ?? 0) > 0;
  }

  private getTickBuffer(marketName: string): MarketTick[] {
    let buffer = this.tickBuffersByMarket.get(marketName);

    if (!buffer) {
      buffer = [];
      this.tickBuffersByMarket.set(marketName, buffer);
    }

    return buffer;
  }
}

export const marketStatisticsAggregationService =
  new MarketStatisticsAggregationService();
