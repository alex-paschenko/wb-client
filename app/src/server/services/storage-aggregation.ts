// app/src/server/services/storage-aggregation.ts

import { storageConfig } from '../../shared/services/storage-config.js';
import { globalStateService } from '../../shared/services/global-state.js';
import { Storage } from '../../shared/services/storage.js';
import type {
  SnapshotTypes,
  StorageItemValues,
} from '../../shared/types/storage.js';
import type { MarketCandle } from '../../shared/types/data-types.js';
import type { LazyArray } from '../../shared/utilities/lazy-array.js';
import { Awaiters, waitFor } from '../../shared/utilities/awaiters.js';
import { SERVER_EVENT } from '../constants/events.js';
import type {
  EntitiesRecalculatedEvent,
  MarketTickReceivedEvent,
  StorageFullSyncRequestEvent,
} from '../types/events.js';
import type { MarketTick } from '../types/market-statistics.js';
import { getMiddleTimestamp } from '../utilities/time.js';
import { Freezing } from '../utilities/freezing.js';
import { eventBus } from './event-bus.js';
import { storagePersistenceService } from './storage-persistence.js';
import { CANDLE_NAME } from '../../shared/constants/storage-entities.js';
import { SNAPSHOT_BATCH_SIZE } from '../constants/persistence.js';
import {
  type DecodedEntireBinary,
  decodeEntireBinary,
} from '../../shared/utilities/codecs/entire-binary-codec.js';
import type { NullableTypedObjectValue } from '../../shared/types/codecs.js';

const SNAPSHOT_WORKER_INTERVAL = 1_000;

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

  private readonly snapshotScheduledAt = new Map<string, number>();

  private snapshotWorkerTimer: ReturnType<typeof setInterval> | null = null;

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
      SERVER_EVENT.freezeOnStorageNeedsToBeLowered,
      (event) => { this.freezingByMarket.warm(event.marketName); },
    );

    eventBus.on(
      SERVER_EVENT.storageFullSyncRequest,
      (event) => { void this.handleFullSyncRequest(event); }
    );

    await globalStateService.waitForStorageEntities();
    await globalStateService.waitForMarkets();

    await this.prepareStoragesFromDatabase();

    eventBus.on(
      SERVER_EVENT.marketTickReceived,
      (event) => { this.handleTickReceived(event); },
    );

    this.startSnapshotWorker();

    // TODO Remove it! For testing purpose only!
    const storages = this.storagesByMarket;

    setInterval(() => {
      let marketName = '---';
      let numOfPoints = 0;

      for (const [currentMarketName, storage] of storages.entries()) {
        const currentNumOfPoints =
          storage.size - storage.getLevelBoundaries()[0];

        if (currentNumOfPoints > numOfPoints) {
          numOfPoints = currentNumOfPoints;
          marketName = currentMarketName;
        }
      }

      console.log(
        `Most active market: ${marketName} (${numOfPoints})`,
      );
    }, 30_000);
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

    void this.processLiveTick(event.marketName, event.tick).finally(
      () => { this.freezingByMarket.warmAndMeltIce(event.marketName); }
    );
  }

  private async processLiveTick(
    marketName: string,
    tick: MarketTick,
  ): Promise<void> {
    const storage = this.getOrCreateStorage(marketName);

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
      const aggregated = this.aggregateLiveLevel(storage, sourceLevel);

      if (!aggregated) {
        break;
      }

      await this.recalculateEntities(marketName, storage);
    }

    this.trimMaxLevel(storage);

    const data = storage.getBinaryDelta();

    if (data) {
      eventBus.emit(SERVER_EVENT.storageDeltaCreated, { marketName, data });
    }

    storage.clearAccessors();

    if (!this.snapshotScheduledAt.has(marketName)) {
      this.snapshotScheduledAt.set(marketName, Date.now());
    }
  }

  private aggregateLiveLevel(
    storage: Storage,
    sourceLevel: number,
  ): boolean {
    const candles = this.getCandlesAccessor(storage);
    const sourceRange = this.getLevelRange(storage, sourceLevel);

    if (sourceRange.start === sourceRange.end) {
      return false;
    }

    const sourceConfig = storageConfig.getLevelConfig(sourceLevel);

    const targetConfig = storageConfig.getLevelConfig(sourceLevel + 1);

    const startedAt = candles.get(sourceRange.start, 'startedAt');
    const endedAt = candles.get(sourceRange.end - 1, 'endedAt',);

    if (endedAt - startedAt <= sourceConfig.interval + targetConfig.duration) {
      return false;
    }

    const cutoff = endedAt - sourceConfig.interval;
    const count = this.countItemsBefore(candles, sourceRange, cutoff);

    if (count === 0) {
      return false;
    }

    const bucketCount = this.getFirstBucketCount(
      candles,
      sourceRange.start,
      count,
      targetConfig.duration,
    );

    if (bucketCount === 0) {
      return false;
    }

    const sourceCandles =
      this.readCandles(candles, sourceRange.start, bucketCount);

    const aggregatedCandle = this.aggregateCandles(sourceCandles);

    const newStartedAt =
      this.getStartedAtAfterDelete(candles, sourceRange, bucketCount);

    storage.deleteNItems(sourceLevel, bucketCount, newStartedAt);

    storage.addItem(
      sourceLevel + 1,
      aggregatedCandle.startedAt,
      aggregatedCandle.endedAt,
      this.createCandleValues(aggregatedCandle),
    );

    return true;
  }

  private async prepareStoragesFromDatabase(): Promise<void> {
    const maxLevelConfig =
      storageConfig.getLevelConfig(storageConfig.maxLevel);

    const databaseMarketNames =
      await storagePersistenceService.getAliveMarketNames();

    const activeMarketNames = new Set(
      globalStateService.getMarketNames() ?? [],
    );

    console.log(
      'Market statistics startup aggregation started',
      { markets: databaseMarketNames.length },
    );

    const totalMarkets = databaseMarketNames.length;
    const marketsToDelete: string[] = [];

    let processed = 0;
    let reportedDecile = 0;

    while (databaseMarketNames.length > 0) {
      const marketNamesBatch =
        databaseMarketNames.splice(0, SNAPSHOT_BATCH_SIZE);

      const snapshots = await storagePersistenceService.getAliveForRestore(
        maxLevelConfig.cutoff,
        marketNamesBatch,
      );

      const restoredNames = new Set(
        snapshots.map((snapshot) => snapshot.marketName),
      );

      for (const marketName of marketNamesBatch) {
        if (!restoredNames.has(marketName)) {
          marketsToDelete.push(marketName);
        }
      }

      for (const snapshot of snapshots) {
        const marketName = snapshot.marketName;
        this.freezingByMarket.coolAndIce(marketName);

        try {
          const storage = this.getOrCreateStorage(marketName);

          const predecodedSnapshot = decodeEntireBinary(snapshot.data);
          this.validatePredecodedSnapshot(predecodedSnapshot, marketName);

          storage.applySnapshot({
            codecName: predecodedSnapshot.codecName,
            data: predecodedSnapshot.data,
          });

          storage.initDelta('restrict');

          await this.prepareStartupStorage(marketName, storage);

          if (activeMarketNames.has(marketName)) {
            this.snapshotScheduledAt.set(marketName, Date.now());
          } else {
            this.emitPersistenceSnapshots(
              marketName,
              storage,
              'archive snapshot only',
            );

            this.removeMarketStorage(marketName);
          }
        } finally {
          this.freezingByMarket.warmAndMeltIce(marketName);
        }
      }

      processed += marketNamesBatch.length;

      const currentDecile = Math.min(
        10,
        Math.floor(processed * 10 / totalMarkets),
      );

      if (currentDecile > reportedDecile) {
        for (
          let value = reportedDecile + 1;
          value <= currentDecile;
          value++
        ) {
          console.log(`processed: ${value}/10`);
        }

        reportedDecile = currentDecile;
      }
    }

    await storagePersistenceService.deleteAlives(marketsToDelete);

    console.log(
      'Market statistics startup aggregation finished',
      { storages: this.storagesByMarket.size },
    );
  }

  private async prepareStartupStorage(
    marketName: string,
    storage: Storage,
  ): Promise<void> {
    for (
      let sourceLevel = 0;
      sourceLevel < storageConfig.maxLevel;
      sourceLevel++
    ) {
      const sourceConfig = storageConfig.getLevelConfig(sourceLevel);

      const aggregated = this.aggregateStartupLevel(
        storage,
        sourceLevel,
        sourceConfig.cutoff,
      );

      if (aggregated) {
        await this.recalculateEntities(marketName, storage);
      }
    }

    this.trimMaxLevel(storage);

    storage.clearAccessors();
  }

  private aggregateStartupLevel(
    storage: Storage,
    sourceLevel: number,
    cutoff: number,
  ): boolean {
    const candles = this.getCandlesAccessor(storage);
    const sourceRange = this.getLevelRange(storage, sourceLevel);

    const count = this.countItemsBefore(candles, sourceRange, cutoff);

    if (count === 0) {
      return false;
    }

    const targetLevel = sourceLevel + 1;

    const targetDuration = storageConfig.getLevelConfig(targetLevel).duration;

    const sourceCandles = this.readCandles(candles, sourceRange.start, count);

    const aggregatedCandles = this.aggregateCandlesByDuration(
      sourceCandles,
      targetDuration,
    );

    const newStartedAt = this.getStartedAtAfterDelete(
      candles,
      sourceRange,
      count,
    );

    storage.deleteNItems(sourceLevel, count, newStartedAt);

    for (const candle of aggregatedCandles) {
      storage.addItem(
        targetLevel,
        candle.startedAt,
        candle.endedAt,
        this.createCandleValues(candle),
      );
    }

    return true;
  }

  private trimMaxLevel(
    storage: Storage,
  ): void {
    const candles = this.getCandlesAccessor(storage);

    const range = this.getLevelRange(storage, storageConfig.maxLevel);

    const count = this.countItemsBefore(
      candles,
      range,
      storageConfig.getLevelConfig(storageConfig.maxLevel).cutoff,
    );

    if (count === 0) {
      return;
    }

    const newStartedAt = this.getStartedAtAfterDelete(
      candles,
      range,
      count,
    );

    storage.deleteNItems(storageConfig.maxLevel, count, newStartedAt);
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

  private async handleFullSyncRequest(
    event: StorageFullSyncRequestEvent,
  ): Promise<void> {
    const { marketName, eventId, freezeStorage } = event;
    const storage = this.getOrCreateStorage(marketName);

    const awaiter = (
      freezingByMarket: Freezing,
      marketName: string,
      resolver: (_: void) => void,
    ) => {
      if (!freezingByMarket.isIcy(marketName)) {
        resolver();
      }
    };

    await waitFor(
      (resolver: (_: void) => void) => {
        awaiter(this.freezingByMarket, marketName, resolver);
      },
      3,
    );

    // This freeze is started when any client requests a full
    // synchronization. It will be finished (via
    // "freezeOnStorageNeedsToBeLowered" event) only after that client
    // subscribes to the deltas — otherwise, the client may lose
    // some deltas.
    if (freezeStorage) {
      this.freezingByMarket.cool(marketName);
    }

    try {
      const data = storage.getBinarySnapshot();

      eventBus.emit(
        SERVER_EVENT.storageFullSyncResults,
        { marketName, eventId, data },
      );
    } catch (error) {
      if (freezeStorage) {
        this.freezingByMarket.warm(marketName);
      }

      throw error;
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

  private aggregateCandlesByDuration(
    candles: readonly MarketCandle[],
    duration: number,
  ): MarketCandle[] {
    if (candles.length === 0) {
      return [];
    }

    const result: MarketCandle[] = [];

    let start = 0;

    while (start < candles.length) {
      let end = start + 1;

      while (
        end < candles.length &&
        candles[end - 1].endedAt - candles[start].startedAt < duration
      ) {
        end++;
      }

      const bucket = candles.slice(start, end);

      const aggregated = this.aggregateCandles(bucket);
      result.push(aggregated);

      start = end;
    }

    return result;
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
    if (count === 0) {
      return 0;
    }

    const startedAt = candles.get(start, 'startedAt');

    for (let offset = 0; offset < count; offset++) {
      const endedAt = candles.get(start + offset, 'endedAt');

      if (endedAt - startedAt >= duration) {
        return offset + 1;
      }
    }

    return 0;
  }

  private countItemsBefore(
    candles: LazyArray<MarketCandle>,
    range: LevelRange,
    cutoff: number,
  ): number {
    let index = range.start;

    while (index < range.end && candles.get(index, 'endedAt') < cutoff) {
      index++;
    }

    return index - range.start;
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

  private getLastLevelCandle(
    storage: Storage,
    level: number,
  ): MarketCandle | null {
    const range = this.getLevelRange(storage, level);

    if (range.start === range.end) {
      return null;
    }

    return this.getCandlesAccessor(storage).get(range.end - 1);
  }

  private getLevelRange(
    storage: Storage,
    level: number,
  ): LevelRange {
    const boundaries = storage.getLevelBoundaries();

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

  private getOrCreateStorage(
    marketName: string,
  ): Storage {
    const existing = this.storagesByMarket.get(marketName);

    if (existing) {
      return existing;
    }

    const storage = new Storage(marketName);

    this.storagesByMarket.set(marketName, storage);

    return storage;
  }

  private removeMarketStorage(
    marketName: string,
  ): void {
    this.storagesByMarket.delete(marketName);
    this.tickBuffersByMarket.delete(marketName);
    this.snapshotScheduledAt.delete(marketName);

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

    const tick = this.getTickBuffer(marketName).shift();

    if (!tick) {
      return;
    }

    this.freezingByMarket.coolAndIce(marketName);

    void this.processLiveTick(marketName, tick)
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
      () => { this.snapshotWorkerTick(); },
      SNAPSHOT_WORKER_INTERVAL,
    );
  }

  private snapshotWorkerTick(): void {
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

      this.emitPersistenceSnapshots(marketName, storage, 'both snapshots');

      this.snapshotScheduledAt.set(
        marketName,
        now + this.getNextSnapshotInterval(),
      );
    }
  }

  private emitPersistenceSnapshots(
    marketName: string,
    storage: Storage,
    snapshotTypes: SnapshotTypes,
  ): void {
    this.freezingByMarket.cool(marketName);

    try {
      let snapshots = storage.getPersistenceSnapshot(snapshotTypes);

      if (snapshots.length === 0) {
        return;
      }

      eventBus.emit(
        SERVER_EVENT.storageSnapshoted,
        { snapshots },
      );
    } finally {
      /*
       * Snapshot encoding is synchronous. Lower the freeze immediately
       * after Storage has returned the immutable binary snapshots.
       */
      this.freezingByMarket.warm(marketName);
    }
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
