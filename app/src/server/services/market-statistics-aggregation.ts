// app/src/server/services/market-statistics-aggregation.ts
import { SERVER_EVENT } from '../constants/events.js';
import {
  MARKET_STATISTICS_LEVEL_CONFIGS,
} from '../../shared/constants/market-statistics-config.js';
import { eventBus } from './event-bus.js';

import type {
  MarketCandle,
} from '../../shared/types/market-statistics-storage.js';
import type {
  MarketIndicatorsRegistry,
} from '../../shared/types/market-indicators.js';
import {
  MarketStatisticsStorageService,
} from '../../shared/services/market-statistics-storage.js';
import type {
  MarketTickReceivedEvent,
  MarketStatisticsPersistenceChange,
  MarketStatisticsRestoredEvent,
  MarketIndicatorsRegistryReadyEvent,
  RecalculateIndicatorsResultsEvent,
} from '../types/events.js';
import { MarketTick } from '../types/market-statistics.js';
import { getMiddleTimestamp } from '../utilities/time.js';
import { calculateCandlePrice, calculateSpeed } from '../utilities/price.js';

export class MarketStatisticsAggregationService {
  private readonly storagesByMarket = new Map<
    string,
    MarketStatisticsStorageService
  >();

  private readonly freezingByMarket = new Map<string, number>();

  private readonly tickBuffersByMarket = new Map<string, MarketTick[]>();

  private indicatorRegistry: MarketIndicatorsRegistry = [];

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
      SERVER_EVENT.marketIndicatorsRegistryReady,
      (event) => this.handleMarketIndicatorsRegistryReady(event),
    );

    eventBus.on(
      SERVER_EVENT.recalculateIndicatorsResults,
      (event) => this.handleRecalculateIndicatorsResults(event),
    );

    eventBus.on(
      SERVER_EVENT.freezeOnStatisticsStorageNeedsToBeLowered,
      (event) => this.decrementFreezing(event.marketName),
    );

    // TODO Remove it! For testing purpose only!
    const stor = this.storagesByMarket;
    setInterval(() => {
      let marketName = '---';
      let numOfPoints = 0;

      for (const [k, v] of stor.entries()) {
        const nop = v.size(0);

        if (nop > numOfPoints) {
          numOfPoints = nop;
          marketName = k;
        }
      }

      console.log(`Most active market: ${marketName} (${numOfPoints})`);
    }, 30000);
  }

  public createFullSyncSnapshot(
    marketName: string,
  ): MarketCandle[][] {
    this.incrementFreezing(marketName);

    const storage = this.getOrCreateStorage(marketName);

    return storage.getAllItemsByLevel();
  }

  public getStorageItemsByMarket(): Record<string, MarketCandle[][]> {
    return Object.fromEntries(
      [...this.storagesByMarket.entries()].map(([marketName, storage]) => [
        marketName,
        storage.getAllItemsByLevel(),
      ]),
    );
  }

  private tickToCandle(
    storage: MarketStatisticsStorageService,
    newTick: MarketTick,
  ): MarketCandle {
    const previousTick = storage.getLastItem(0);
    const { receivedAt, price } = newTick;

    return {
      ...newTick,
      speed: calculateSpeed(
        previousTick?.receivedAt,
        previousTick?.price,
        receivedAt,
        price,
      ),
      receivedAt,
      startedAt: receivedAt,
      endedAt: receivedAt,
      open: price,
      close: price,
      high: price,
      low: price,
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

    this.incrementFreezing(event.marketName);
    this.tickProcessor(event.marketName, event.tick);
  }

  private tickProcessor(
    marketName: string,
    tick: MarketTick,
  ): void {
    const storage = this.getOrCreateStorage(marketName);
    const candle = this.tickToCandle(storage, tick);

    const previousTick = storage.getLastItem(0);

    if (previousTick?.receivedAt === candle.receivedAt) {
      console.warn('Duplicate tick received', candle);
      this.decrementFreezing(marketName);
      return;
    }

    storage.addItem(
      0,
      candle,
      'should record delta',
    );

    const centralIndexesAsc = this.aggregate(storage);

    this.emitRecalculateIndicatorsRequest(
      storage,
      centralIndexesAsc,
      centralIndexesAsc.length + 1,
    );
  }

  private aggregate(
    storage: MarketStatisticsStorageService,
  ): number[] {
    const centralIndexesAsc: number[] = [];

    for (
      let level = 0;
      level < MARKET_STATISTICS_LEVEL_CONFIGS.length - 1;
      level += 1
    ) {
      const currentConfig = MARKET_STATISTICS_LEVEL_CONFIGS[level];
      const nextConfig = MARKET_STATISTICS_LEVEL_CONFIGS[level + 1];

      const startedAt = storage.getStartedAt(level);
      const endedAt = storage.getEndedAt(level);

      if (startedAt === null || endedAt === null) {
        return centralIndexesAsc;
      }

      if (
        endedAt - startedAt <=
        currentConfig.interval + nextConfig.duration
      ) {
        return centralIndexesAsc;
      }

      const cutoff = endedAt - currentConfig.interval;
      const items = storage.readItemsBefore(level, cutoff);

      if (items.length === 0) {
        return centralIndexesAsc;
      }

      const candle = this.aggregateCandles(items);

      storage.removeNItems(
        level,
        items.length,
        'should record delta',
      );

      const index = storage.addItem(
        level + 1,
        candle,
        'should record delta',
      );

      centralIndexesAsc.push(index);
    }

    return centralIndexesAsc;
  }

  private handleRecalculateIndicatorsResults(
    event: RecalculateIndicatorsResultsEvent,
  ): void {
    const storage = this.getOrCreateStorage(event.marketName);

    for (const result of event.indicators) {
      storage.addIndicatorResults(result);
    }

    const delta = storage.commitDelta();

    if (delta) {
      eventBus.emit(SERVER_EVENT.marketStatisticsStorageChanged, {
        marketName: event.marketName,
        delta,
      });
    }

    eventBus.emit(SERVER_EVENT.marketStatisticsPersistenceChanged, {
      marketName: event.marketName,
      changes: this.toPersistenceChanges(
        storage,
        event.numOfAffectedLevels,
      ),
    });

    this.decrementFreezing(event.marketName);
  }

  private handleMarketIndicatorsRegistryReady(
    event: MarketIndicatorsRegistryReadyEvent,
  ): void {
    this.indicatorRegistry = event.registry;

    for (const storage of this.storagesByMarket.values()) {
      storage.setIndicatorRegistry(event.registry);
    }
  }

  private toPersistenceChanges(
    storage: MarketStatisticsStorageService,
    numOfAffectedLevels: number,
  ): MarketStatisticsPersistenceChange[] {
    return Array.from(
      { length: numOfAffectedLevels },
      (_, level) => {
        const item = storage.getLastItem(level);
        const deleteBefore = storage.getStartedAt(level);

        if (!item) {
          throw new Error(
            `Market statistics level ${level} has no latest item.`,
          );
        }

        if (deleteBefore === null) {
          throw new Error(
            `Market statistics level ${level} is empty after adding item.`,
          );
        }

        return {
          item,
          deleteBefore,
        };
      },
    );
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
    const receivedAt = getMiddleTimestamp(startedAt, endedAt);

    const open = first.open;
    const close = last.close;

    return {
      receivedAt,
      price: calculateCandlePrice(open, close, high, low),
      speed: calculateSpeed(
        first.startedAt,
        first.price,
        last.endedAt,
        last.price,
      ),

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
    created.setIndicatorRegistry(this.indicatorRegistry);

    this.storagesByMarket.set(marketName, created);

    return created;
  }

  private handleMarketStatisticsRestored(
    event: MarketStatisticsRestoredEvent,
  ): void {
    for (const [marketName, data] of Object.entries(event.itemsByMarket)) {
      const storage = this.getOrCreateStorage(marketName);

      for (const [level, candles] of data.entries()) {
        for (const candle of candles) {
          storage.addItem(
            level,
            candle,
            'suppress record delta',
          );
        }
      }

      storage.commitDelta();
    }
  }

  private incrementFreezing(marketName: string): void {
    this.freezingByMarket.set(
      marketName,
      (this.freezingByMarket.get(marketName) ?? 0) + 1,
    );
  }

  private decrementFreezing(marketName: string): void {
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

      this.incrementFreezing(marketName);
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

  private emitRecalculateIndicatorsRequest(
    storage: MarketStatisticsStorageService,
    centralIndexesAsc: number[] = [],
    numOfAffectedLevels = 1,
  ): void {
    eventBus.emit(
      SERVER_EVENT.recalculateIndicatorsRequest,
      {
        ...storage.getMarketDataView(),
        centralIndexesAsc,
        numOfAffectedLevels,
      },
    );
  }
}

export const marketStatisticsAggregationService =
  new MarketStatisticsAggregationService();
