// app/src/server/services/storage-aggregation.ts

import { writeFile } from 'node:fs/promises';

import { storageConfig } from '../../shared/services/storage-config.js';
import { globalStateService } from '../../shared/services/global-state.js';
import { Storage } from '../../shared/services/storage.js';
import type { StorageItemValues } from '../../shared/types/storage.js';
import type { MarketCandle } from '../../shared/types/data-types.js';
import type { LazyArray } from '../../shared/utilities/lazy-array.js';
import { Awaiters, waitFor } from '../../shared/utilities/awaiters.js';
import { SERVER_EVENT } from '../constants/events.js';
import type {
  EntitiesRecalculatedEvent,
  MarketTickReceivedEvent,
  StorageFullSyncRequestEvent,
  StrategiesCompletedEvent,
} from '../types/events.js';
import type { MarketTick } from '../../shared/types/ticks.js';
import { getMiddleTimestamp } from '../utilities/time.js';
import { Freezing } from '../utilities/freezing.js';
import { eventBus } from './event-bus.js';
import { storagePersistenceService } from './storage-persistence.js';
import { CANDLE_NAME } from '../../shared/constants/storage-entities.js';
import {
  type DecodedEntireBinary,
  decodeEntireBinary,
} from '../../shared/utilities/codecs/entire-binary-codec.js';
import type { NullableTypedObjectValue } from '../../shared/types/codecs.js';
import { SECOND, SECONDS } from '../../shared/constants/time.js';

const SNAPSHOT_WORKER_INTERVAL = 1 * SECOND;
const STARTUP_SNAPSHOT_JITTER = 16 * SECONDS;

interface LevelRange {
  start: number;
  end: number;
}

export class StorageAggregationService {
  private readonly storagesByMarket = new Map<string, Storage>();

  private readonly freezingByMarket: Freezing;

  private readonly tickBuffersByMarket = new Map<string, MarketTick[]>();

  private readonly entitiesRecalculatedAwaiters =
    new Awaiters<string, EntitiesRecalculatedEvent>();

  private readonly strategiesCompletedAwaiters =
    new Awaiters<string, StrategiesCompletedEvent>();

  private readonly lastEndedAtByMarket = new Map<string, number>();

  private snapshotWorkerBusy = false;

  private readonly snapshotScheduledAt = new Map<string, number>();

  private snapshotWorkerTimer: ReturnType<typeof setInterval> | null = null;

  private unsubscribeMarkets: (() => void) | null = null;

  public constructor() {
    this.freezingByMarket = new Freezing(
      (marketName: string) => { this.flushTickBuffer(marketName); },
    );
  }

  public async start(): Promise<void> {
    eventBus.on(
      SERVER_EVENT.entitiesRecalculated,
      (event) => { this.handleEntitiesRecalculated(event); },
    );

    eventBus.on(
      SERVER_EVENT.strategiesCompleted,
      (event) => { this.handleStrategiesCompleted(event); },
    );

    eventBus.on(
      SERVER_EVENT.storageFullSyncRequest,
      (event) => { void this.handleFullSyncRequest(event); }
    );

    await globalStateService.waitForStorageEntities();
    await globalStateService.waitForMarkets();


    const marketNames = globalStateService.getMarketNames() ?? [];

    console.log('Market statistics storage restore started', {
      markets: marketNames.length,
    });

    let processed = 0;
    let reportedDecile = 0;

    for (const marketName of marketNames) {
      this.freezingByMarket.coolAndIce(marketName);

      try {
        await this.getOrCreateStorage(marketName);
      } finally {
        this.freezingByMarket.warmAndMeltIce(marketName);
      }

      processed++;

      const currentDecile = Math.min(
        10,
        Math.floor(processed * 10 / marketNames.length),
      );

      for (let value = reportedDecile + 1; value <= currentDecile; value++) {
        console.log(`processed: ${value}/10`);
      }

      reportedDecile = currentDecile;
    }

    console.log('Market statistics storage restore finished', {
      storages: this.storagesByMarket.size,
    });

    this.unsubscribeMarkets = globalStateService.subscribeMarkets(
      (_markets, updatedMarketNames) => {
        if (updatedMarketNames !== null) {
          void this.handleMarketNamesChanged().catch((error: unknown) => {
            console.error('Failed to handle market list update', error);
          });
        }
      },
    );

    eventBus.on(
      SERVER_EVENT.marketTickReceived,
      (event) => { this.handleTickReceived(event); },
    );

    this.startSnapshotWorker();

    // TODO For testing purpose only!
    const storages = this.storagesByMarket;

    setInterval(() => {
      let marketName = '---';
      let startL0Timestamp = 0;
      let size = 0;

      for (const [currentMarketName, storage] of storages.entries()) {
        if (storage.levelBoundaries[0] >= storage.size) {
          continue;
        }

        const candles = storage.getAccessors()['candles'][CANDLE_NAME]  as LazyArray<MarketCandle>;
        const currentL0Timestamp = candles.get(storage.levelBoundaries[0], 'receivedAt');

        if (currentL0Timestamp > startL0Timestamp) {
          size = storage.size;
          startL0Timestamp = currentL0Timestamp;
          marketName = currentMarketName;
        }
      }

      console.log(
        `Most active market: ${marketName} (L0 startedAt: ` +
        `${new Date(startL0Timestamp).toLocaleTimeString('ru-RU')}, size: ${size})`,
      );

    //   if (marketName === '---') {
    //     return;
    //   }

    //   this.freezingByMarket.cool(marketName);

    //   const storage = this.getOrCreateStorage(marketName);
    //   const data: any[] = [];
    //   const accessors = storage.getAccessors();
    //   const candles = accessors['candles'][CANDLE_NAME] as LazyArray<MarketCandle>;
    //   const indicators = accessors['indicators'];

    //   for (let index = 0; index < storage.size; index++) {
    //     const dataItem = {
    //       candle: candles.get(index),
    //       marketPhase: indicators['phase-30s'].get(index),
    //     };

    //     data.push(dataItem);
    //   }

    //   writeFile(
    //     `./logs/${marketName}.json`,
    //     JSON.stringify({ data, levelBoundaries: storage.levelBoundaries }, null, 2),
    //     'utf8',
    //   );

    //   this.freezingByMarket.warm(marketName);
    }, 30_000);
  }

  async stop() {
    this.unsubscribeMarkets?.();
    this.unsubscribeMarkets = null;

    if (this.snapshotWorkerTimer) {
      clearInterval(this.snapshotWorkerTimer);
      this.snapshotWorkerTimer = null;
    }
  }

  private handleTickReceived(
    event: MarketTickReceivedEvent,
  ): void {
    const buffer = this.getTickBuffer(event.marketName);

    if (this.freezingByMarket.isCold(event.marketName) || buffer.length > 0) {
      buffer.push(event.tick);
      return;
    }

    this.freezingByMarket.coolAndIce(event.marketName);

    void this.processTick(event.marketName, event.tick).finally(
      () => { this.freezingByMarket.warmAndMeltIce(event.marketName); }
    );
  }

  private async processTick(
    marketName: string,
    tick: MarketTick,
  ): Promise<void> {
    const storage = await this.getOrCreateStorage(marketName);

    if (storage.endedAt === tick.receivedAt) {
      console.warn(
        'Duplicate market tick received',
        { marketName, tick },
      );
      return;
    }

    const candle = this.tickToCandle(tick);

    storage.initDelta('allow');

    storage.addItem(
      0,
      candle.startedAt,
      candle.endedAt,
      this.createCandleValues(candle),
    );

    await this.recalculateEntities(marketName, storage);

    for (
      let sourceLevel = 0;
      sourceLevel < storageConfig.maxLevel;
      sourceLevel++
    ) {
      const aggregated = this.aggregateLevel(storage, sourceLevel);

      if (aggregated) {
        await this.recalculateEntities(marketName, storage);
      }
    }

    this.trimMaxLevel(storage);

    const data = storage.getBinaryDelta();

    if (data) {
      eventBus.emit(
        SERVER_EVENT.storageDeltaCreated,
        { marketName, data },
      );
    }

    const size = storage.size;
    const endedAt = storage.endedAt;
    if (endedAt === null) {
      return;
    }

    // const completed = this.strategiesCompletedAwaiters.wait(marketName);

    // eventBus.emit(SERVER_EVENT.runStrategiesRequest, {
    //   marketName,
    //   accessors: storage.getAccessors(),
    //   size,
    //   endedAt,
    // });

    // const result = await completed;

    // if (
    //   result.size !== size
    //   || result.endedAt !== endedAt
    //   || storage.size !== size
    //   || storage.endedAt !== endedAt
    // ) {
    //   throw new Error('Storage changed during strategy execution');
    // }

    // if (result.error !== undefined) {
    //   throw result.error;
    // }

    storage.clearAccessors();

    if (!this.snapshotScheduledAt.has(marketName)) {
      this.snapshotScheduledAt.set(marketName, Date.now());
    }
  }

  private aggregateLevel(
    storage: Storage,
    sourceLevel: number,
  ): boolean {
    const sourceConfig = storageConfig.getLevelConfig(sourceLevel);
    const targetLevel = sourceLevel + 1;
    const targetConfig = storageConfig.getLevelConfig(targetLevel);

    let aggregated = false;

    while (true) {
      const sourceRange = this.getLevelRange(storage, sourceLevel);
      const sourceCount = sourceRange.end - sourceRange.start;

      if (sourceCount < sourceConfig.maxCount) {
        break;
      }

      const candles = this.getCandlesAccessor(storage);

      const bucketCount = this.getFirstBucketCount(
        candles,
        sourceRange.start,
        sourceCount,
        targetConfig.duration,
      );

      const sourceCandles = this.readCandles(
        candles,
        sourceRange.start,
        bucketCount,
      );

      const aggregatedCandle = this.aggregateCandles(sourceCandles);

      const newStartedAt = this.getStartedAtAfterDelete(
        candles,
        sourceRange,
        bucketCount,
      );

      storage.deleteNItems(sourceLevel, bucketCount, newStartedAt);

      storage.addItem(
        targetLevel,
        aggregatedCandle.startedAt,
        aggregatedCandle.endedAt,
        this.createCandleValues(aggregatedCandle),
      );

      aggregated = true;
    }

    return aggregated;
  }

  private async handleMarketNamesChanged(): Promise<void> {
    const marketNames = globalStateService.getMarketNames() ?? [];
    const activeMarkets = new Set(marketNames);

    for (const [marketName, storage] of this.storagesByMarket) {
      if (activeMarkets.has(marketName)) {
        continue;
      }

      this.freezingByMarket.cool(marketName);

      try {
        await waitFor(
          (resolve: (_: void) => void) => {
            if (!this.freezingByMarket.isIcy(marketName)) {
              resolve();
            }
          },
          3,
        );

        this.freezingByMarket.coolAndIce(marketName);

        try {
          if (globalStateService.hasMarket(marketName)) {
            continue;
          }

          await this.emitFinalMarketSnapshots(marketName, storage);
          this.removeMarketStorage(marketName);
        } finally {
          this.freezingByMarket.warmAndMeltIce(marketName);
        }
      } finally {
        this.freezingByMarket.warm(marketName);
      }
    }

    for (const marketName of marketNames) {
      if (this.storagesByMarket.has(marketName)) {
        continue;
      }

      this.freezingByMarket.coolAndIce(marketName);

      try {
        await this.getOrCreateStorage(marketName);
      } finally {
        this.freezingByMarket.warmAndMeltIce(marketName);
      }
    }
  }

  private async emitFinalMarketSnapshots(
    marketName: string,
    storage: Storage,
  ): Promise<void> {
    const storageEndedAt = storage.endedAt;

    if (storageEndedAt === null) {
      return;
    }

    let lastEndedAt = this.lastEndedAtByMarket.get(marketName);

    if (lastEndedAt === undefined) {
      lastEndedAt = await storagePersistenceService.getLastArchiveEndedAt(
        marketName,
      );
      this.lastEndedAtByMarket.set(marketName, lastEndedAt);
    }

    if (storageEndedAt <= lastEndedAt) {
      return;
    }

    const candles = this.getCandlesAccessor(storage);
    const archiveStartIndex = this.findFirstEndedAfter(candles, lastEndedAt);

    if (archiveStartIndex >= storage.size) {
      return;
    }

    const snapshots = storage.getPersistenceSnapshot(
      'both snapshots',
      archiveStartIndex,
      candles.get(archiveStartIndex, 'startedAt'),
    );

    if (snapshots.length === 0) {
      return;
    }

    eventBus.emit(SERVER_EVENT.storageSnapshoted, { snapshots });
  }

  private trimMaxLevel(
    storage: Storage,
  ): void {
    const maxLevel = storageConfig.maxLevel;
    const maxLevelConfig = storageConfig.getLevelConfig(maxLevel);

    const candles = this.getCandlesAccessor(storage);
    const range = this.getLevelRange(storage, maxLevel);

    const levelCount = range.end - range.start;
    const countToDelete = levelCount - maxLevelConfig.maxCount;

    if (countToDelete <= 0) {
      return;
    }

    const newStartedAt = this.getStartedAtAfterDelete(
      candles,
      range,
      countToDelete,
    );

    storage.deleteNItems(maxLevel, countToDelete, newStartedAt);
  }

  private async recalculateEntities(
    marketName: string,
    storage: Storage,
  ): Promise<void> {
    const endedAt = storage.endedAt;

    if (endedAt === null) {
      throw new Error(
        `Cannot recalculate empty storage "${marketName}"`,
      );
    }

    const size = storage.size;

    const recalculated =
      this.entitiesRecalculatedAwaiters.wait(marketName);

    eventBus.emit(
      SERVER_EVENT.recalculateEntitiesRequest,
      {
        accessors: storage.getAccessors(),
        marketName,
        size,
        endedAt,
      },
    );

    const event = await recalculated;

    if (
      event.size !== size ||
      event.endedAt !== endedAt ||
      storage.size !== size ||
      storage.endedAt !== endedAt
    ) {
      throw new Error(
        `Storage "${marketName}" changed during entity recalculation: ` +
        `expected size=${size}, endedAt=${endedAt}; ` +
        `event size=${event.size}, endedAt=${event.endedAt}; ` +
        `actual size=${storage.size}, endedAt=${storage.endedAt}`,
      );
    }

    /*
     * Recalculated entities may themselves have written transitory changes.
     * Clear them only after the entire recalculation pass is complete.
     */
    storage.clearTransitoryChanges();
    storage.clearDeleted();
  }

  private handleEntitiesRecalculated(
    event: EntitiesRecalculatedEvent,
  ): void {
    this.entitiesRecalculatedAwaiters.resolve(event.marketName, event);
  }

  private handleStrategiesCompleted(event: StrategiesCompletedEvent): void {
    this.strategiesCompletedAwaiters.resolve(event.marketName, event);
  }

  private async handleFullSyncRequest(
    event: StorageFullSyncRequestEvent,
  ): Promise<void> {
    const { marketName, eventId } = event;

    this.freezingByMarket.cool(marketName);

    try {
      await waitFor(
        (resolver: (_: void) => void) => {
          if (!this.freezingByMarket.isIcy(marketName)) {
            resolver();
          }
        },
        3,
      );

      const storage = await this.getOrCreateStorage(marketName);
      const data = storage.getBinarySnapshot();

      eventBus.emit(
        SERVER_EVENT.storageFullSyncResults,
        { marketName, eventId, data },
      );
    } finally {
      this.freezingByMarket.warm(marketName);
    }
  }

  private tickToCandle(tick: MarketTick): MarketCandle {
    const { receivedAt, price } = tick;

    return {
      ...tick,
      speed: NaN,
      acceleration: NaN,

      startedAt: receivedAt,
      endedAt: receivedAt,

      open: price,
      close: price,
      high: price,
      low: price,
    };
  }

  private aggregateCandles(
    candles: readonly MarketCandle[],
  ): MarketCandle {
    if (candles.length === 0) {
      throw new Error('Cannot aggregate an empty candle array');
    }

    if (candles.length === 1) {
      return candles[0];
    }

    const first = candles[0];
    const last = candles.at(-1)!;

    let high = first.high;
    let low = first.low;

    for (const candle of candles) {
      high = Math.max(high, candle.high);
      low = Math.min(low, candle.low);
    }

    const startedAt = first.startedAt;
    const endedAt = last.endedAt;
    const receivedAt = getMiddleTimestamp(startedAt, endedAt);

    return {
      receivedAt,

      price: NaN,
      speed: NaN,
      acceleration: NaN,

      startedAt,
      endedAt,

      open: first.open,
      close: last.close,
      high,
      low,
    };
  }

  private getFirstBucketCount(
    candles: LazyArray<MarketCandle>,
    start: number,
    count: number,
    duration: number,
  ): number {
    if (count <= 0) {
      return 0;
    }

    const startedAt = candles.get(start, 'startedAt');

    let bucketCount = 1;

    while (bucketCount < count) {
      const currentEndedAt = candles.get(start + bucketCount - 1, 'endedAt');

      const nextEndedAt = candles.get(start + bucketCount, 'endedAt');

      const currentDifference = Math.abs(
        currentEndedAt - startedAt - duration,
      );

      const nextDifference = Math.abs(
        nextEndedAt - startedAt - duration,
      );

      if (nextDifference >= currentDifference) {
        break;
      }

      bucketCount++;
    }

    return bucketCount;
  }

  private readCandles(
    candles: LazyArray<MarketCandle>,
    start: number,
    count: number,
  ): MarketCandle[] {
    const result = new Array<MarketCandle>(count);

    for (let offset = 0; offset < count; offset++) {
      result[offset] = candles.get(start + offset);
    }

    return result;
  }

  private getStartedAtAfterDelete(
    candles: LazyArray<MarketCandle>,
    range: LevelRange,
    count: number,
  ): number | undefined {
    const nextIndex = range.start + count;

    return nextIndex < range.end
      ? candles.get(nextIndex, 'startedAt')
      : undefined;
  }

  private getLevelRange(
    storage: Storage,
    level: number,
  ): LevelRange {
    const boundaries = storage.levelBoundaries;

    return {
      start: boundaries[level],
      end: level === 0 ? storage.size : boundaries[level - 1],
    };
  }

  private getCandlesAccessor(
    storage: Storage,
  ): LazyArray<MarketCandle> {
    return storage.getAccessors()['candles'][CANDLE_NAME] as
      LazyArray<MarketCandle>;
  }

  private createCandleValues(
    candle: MarketCandle,
  ): StorageItemValues {
    return {
      candles: {
        [CANDLE_NAME]: candle,
      },
    };
  }

  private async getOrCreateStorage(
    marketName: string,
  ): Promise<Storage> {
    const existing = this.storagesByMarket.get(marketName);

    if (existing) {
      return existing;
    }

    const storage = new Storage(marketName);

    this.storagesByMarket.set(marketName, storage);

    try {
      const snapshot = (await storagePersistenceService.getAliveForRestore(
        [marketName],
      ))[0];

      if (snapshot) {
        const predecodedSnapshot = decodeEntireBinary(snapshot.data);
        this.validatePredecodedSnapshot(predecodedSnapshot, marketName);

        storage.applySnapshot({
          codecName: predecodedSnapshot.codecName,
          data: predecodedSnapshot.data,
        });
      }

      this.snapshotScheduledAt.set(
        marketName,
        Date.now() + Math.random() * STARTUP_SNAPSHOT_JITTER,
      );

      return storage;
    } catch (error) {
      this.storagesByMarket.delete(marketName);
      this.snapshotScheduledAt.delete(marketName);
      throw error;
    }
  }

  private removeMarketStorage(
    marketName: string,
  ): void {
    this.storagesByMarket.delete(marketName);
    this.tickBuffersByMarket.delete(marketName);
    this.snapshotScheduledAt.delete(marketName);
    this.lastEndedAtByMarket.delete(marketName);

    eventBus.emit(SERVER_EVENT.marketRemoved, { marketName });
  }

  private getTickBuffer(
    marketName: string,
  ): MarketTick[] {
    let buffer = this.tickBuffersByMarket.get(marketName);

    if (!buffer) {
      buffer = [];
      this.tickBuffersByMarket.set(marketName, buffer);
    }

    return buffer;
  }

  private flushTickBuffer(
    marketName: string,
  ): void {
    if (this.freezingByMarket.isCold(marketName)) {
      return;
    }

    const tick = this.tickBuffersByMarket.get(marketName)?.shift();

    if (!tick) {
      return;
    }

    this.freezingByMarket.coolAndIce(marketName);

    void this.processTick(marketName, tick)
      .finally(
        () => {
          this.freezingByMarket.warmAndMeltIce(marketName);
        }
      );
  }

  private startSnapshotWorker(): void {
    if (this.snapshotWorkerTimer) {
      return;
    }

    this.snapshotWorkerTimer = setInterval(
      () => { void this.snapshotWorkerTick(); },
      SNAPSHOT_WORKER_INTERVAL,
    );
  }

  private async snapshotWorkerTick(): Promise<void> {
    if (this.snapshotWorkerBusy) {
      return;
    }

    this.snapshotWorkerBusy = true;

    try {
      const now = Date.now();

      for (const [marketName, storage] of this.storagesByMarket) {
        const scheduledAt = this.snapshotScheduledAt.get(marketName);

        if (scheduledAt === undefined || scheduledAt > now) {
          continue;
        }

        const isIcy = this.freezingByMarket.isIcy(marketName);
        if (isIcy === null) {
          throw new Error(
            `The "${marketName}" market storage has never been processed`,
          );
        }

        /*
        * Never snapshot a storage while its current tick is being processed.
        * The next worker pass will try again.
        */
        if (isIcy) {
          continue;
        }

        this.freezingByMarket.cool(marketName);

        const isAliveMarket = globalStateService.hasMarket(marketName);

        try {
          let lastEndedAt = this.lastEndedAtByMarket.get(marketName);

          if (lastEndedAt === undefined) {
            lastEndedAt =
              await storagePersistenceService.getLastArchiveEndedAt(
                marketName,
              );

            this.lastEndedAtByMarket.set(marketName, lastEndedAt);
          }

          const storageEndedAt = storage.endedAt;

          if (storageEndedAt !== null && storageEndedAt > lastEndedAt) {
            const candles = this.getCandlesAccessor(storage);
            const archiveStartIndex = this.findFirstEndedAfter(
              candles,
              lastEndedAt,
            );

            if (archiveStartIndex < storage.size) {
              const archiveStartedAt = candles.get(
                archiveStartIndex,
                'startedAt',
              );

              const snapshots = storage.getPersistenceSnapshot(
                isAliveMarket
                  ? 'both snapshots'
                  : 'archive snapshot only',
                archiveStartIndex,
                archiveStartedAt,
              );

              if (snapshots.length > 0) {
                eventBus.emit(
                  SERVER_EVENT.storageSnapshoted,
                  { snapshots },
                );

                const archiveSnapshot = snapshots.find(
                  (snapshot) => snapshot.snapshotType === 'archive',
                );

                if (archiveSnapshot) {
                  this.lastEndedAtByMarket.set(
                    marketName,
                    archiveSnapshot.endedAt,
                  );
                }
              }
            }
          }
        } finally {
          /*
          * Snapshot encoding is synchronous. The only asynchronous operation
          * above is the initial archive boundary lookup, while the storage
          * remains cooled and incoming ticks are buffered.
          */
          this.freezingByMarket.warm(marketName);
        }

        this.snapshotScheduledAt.set(
          marketName,
          now + this.getNextSnapshotInterval(),
        );
      }
    } finally {
      this.snapshotWorkerBusy = false;
    }
  }

  private findFirstEndedAfter(
    candles: LazyArray<MarketCandle>,
    endedAt: number,
  ): number {
    let left = 0;
    let right = candles.length;

    while (left < right) {
      const middle = (left + right) >>> 1;

      if (candles.get(middle, 'endedAt') <= endedAt) {
        left = middle + 1;
      } else {
        right = middle;
      }
    }

    return left;
  }

  private getNextSnapshotInterval(): number {
    const level0Interval = storageConfig.getLevelConfig(0).interval;

    const baseInterval = level0Interval * 3 / 4;
    const jitter = level0Interval / 8;

    return baseInterval + (Math.random() * 2 - 1) * jitter;
  }

  private validatePredecodedSnapshot(
    predecodedSnapshot: DecodedEntireBinary<NullableTypedObjectValue>,
    marketName: string,
  ): void {
    if (predecodedSnapshot.binaryKind !== 'snapshot') {
      throw new TypeError(
        `Invalid market "${marketName}" snapshot: binaryKind is ` +
        `${predecodedSnapshot.binaryKind}`,
      );
    }

    if (
      (predecodedSnapshot.parameters as { marketName: string})
        .marketName !== marketName
    ) {
      throw new Error(
        `Invalid market "${marketName}" snapshot: marketName is ` +
        `"${(predecodedSnapshot.parameters as { marketName: string}).marketName}"`,
      );
    }
  }
}

export const storageAggregationService = new StorageAggregationService();
