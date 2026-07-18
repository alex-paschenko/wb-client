// app/src/server/services/market-statistics-aggregation.ts
import {
  MARKET_STATISTICS_LEVEL_CONFIGS,
} from '../../shared/constants/market-statistics-config.js';
import {
  MarketStatisticsStorageService,
} from '../../shared/services/market-statistics-storage.js';
import type {
  IndicatorResults,
  MarketIndicatorValues,
} from '../../shared/types/market-indicators.js';
import type {
  CandleIndicatorsChange,
  FullMarketStatisticsLevel,
  MarketCandle,
} from '../../shared/types/market-statistics-storage.js';
import {
  SERVER_EVENT,
} from '../constants/events.js';
import {
  marketCandlesDao,
  type MarketCandleRemoveRow,
  type MarketCandleRow,
  type RefreshMarketCandlesInput,
} from '../dao/market-candles.js';
import type {
  MarketStatisticsPersistenceChange,
  MarketStatisticsRestoredEvent,
  MarketTickReceivedEvent,
  RecalculateIndicatorsResultsEvent,
} from '../types/events.js';
import type {
  MarketTick,
} from '../types/market-statistics.js';
import {
  calculateCandlePrice,
  calculateSpeed,
} from '../utilities/price.js';
import {
  getMiddleTimestamp,
} from '../utilities/time.js';
import { getCumulativeCutoffs } from '../../shared/utilities/time.js';
import { eventBus } from './event-bus.js';
import {
  globalStateService
} from '../../shared/services/global-state.js';

interface IndicatorResultWaiter {
  resolve: (
    event: RecalculateIndicatorsResultsEvent,
  ) => void;
}

interface StartupPromotionResult {
  addedRows: MarketCandleRow[];
  removals: MarketCandleRemoveRow[];
  addedItemsByLevel: AddedItemsByLevel[];
}

interface AddedItemsByLevel {
  level: number;
  count: number;
}

const STARTUP_PERSISTENCE_MARKETS_PER_BATCH = 20;

export class MarketStatisticsAggregationService {
  private readonly storagesByMarket = new Map<
    string,
    MarketStatisticsStorageService
  >();

  private readonly freezingByMarket = new Map<string, number>();

  private readonly tickBuffersByMarket = new Map<string, MarketTick[]>();

  private indicatorResultWaiter: IndicatorResultWaiter | null = null;

  public async start(): Promise<void> {
    eventBus.on(
      SERVER_EVENT.recalculateIndicatorsResults,
      (event) => this.handleRecalculateIndicatorsResults(event),
    );

    eventBus.on(
      SERVER_EVENT.freezeOnStatisticsStorageNeedsToBeLowered,
      (event) => this.decrementFreezing(event.marketName),
    );

    await globalStateService.waitForIndicatorRegistry();

    await this.prepareStoragesFromDatabase();

    this.indicatorResultWaiter = null;

    eventBus.on(
      SERVER_EVENT.marketTickReceived,
      (event) => this.handleTickReceived(event),
    );

    // TODO Remove it! For testing purpose only!
    const storages = this.storagesByMarket;

    setInterval(() => {
      let marketName = '---';
      let numOfPoints = 0;

      for (const [currentMarketName, storage] of storages.entries()) {
        const currentNumOfPoints = storage.size(0);

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

  private waitForIndicatorResults():
    Promise<RecalculateIndicatorsResultsEvent> {
    if (this.indicatorResultWaiter) {
      throw new Error(
        'Indicator result waiter already exists',
      );
    }

    return new Promise((resolve) => {
      this.indicatorResultWaiter = {
        resolve,
      };
    });
  }

  private incrementAddedItemsCount(
    addedItemsCountByLevel: Map<number, number>,
    level: number,
    count: number,
  ): void {
    if (count <= 0) {
      return;
    }

    addedItemsCountByLevel.set(
      level,
      (
        addedItemsCountByLevel.get(level) ??
        0
      ) + count,
    );
  }

  private refreshAddedItemsCountAfterRemoval(
    addedItemsCountByLevel: Map<number, number>,
    storage: MarketStatisticsStorageService,
    level: number,
  ): void {
    const addedCount =
      addedItemsCountByLevel.get(level);

    if (addedCount === undefined) {
      return;
    }

    /*
    * Added items occupy the tail of the level.
    * Removing items from the head can only remove
    * added items after all older items have gone.
    */
    const remainingAddedCount = Math.min(
      addedCount,
      storage.size(level),
    );

    if (remainingAddedCount === 0) {
      addedItemsCountByLevel.delete(level);
      return;
    }

    addedItemsCountByLevel.set(
      level,
      remainingAddedCount,
    );
  }

  private toAddedItemsByLevel(
    addedItemsCountByLevel:
      ReadonlyMap<number, number>,
  ): AddedItemsByLevel[] {
    return [...addedItemsCountByLevel.entries()]
      .filter(([, count]) => count > 0)
      .map(([level, count]) => ({
        level,
        count,
      }));
  }

  public createFullSyncSnapshot(
    marketName: string,
  ): FullMarketStatisticsLevel[] {
    this.incrementFreezing(marketName);

    const storage = this.getOrCreateStorage(marketName);

    return storage.getAllItemsByLevel();
  }

  public getStorageItemsByMarket():
    Record<string, FullMarketStatisticsLevel[]> {
    return Object.fromEntries(
      [...this.storagesByMarket.entries()].map(
        ([marketName, storage]) => [
          marketName,
          storage.getAllItemsByLevel(),
        ],
      ),
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

    try {
      this.tickProcessor(event.marketName, event.tick);
    } catch (error) {
      this.decrementFreezing(event.marketName);
      throw error;
    }
  }

  private tickProcessor(
    marketName: string,
    tick: MarketTick,
  ): void {
    const storage = this.getOrCreateStorage(marketName);
    const candle = this.tickToCandle(storage, tick);
    const previousTick = storage.getLastItem(0);

    if (previousTick?.receivedAt === candle.receivedAt) {
      console.warn('Duplicate tick received', {
        marketName,
        candle,
      });

      this.decrementFreezing(marketName);
      return;
    }

    storage.addItem(
      0,
      candle,
      'should record delta',
    );

    const addedItemsByLevel =
      this.aggregate(storage);

    const numOfAffectedLevels = Math.max(
      1,
      ...addedItemsByLevel.map(
        ({ level }) => level + 1,
      ),
    );

    this.emitRecalculateIndicatorsRequest(
      storage,
      addedItemsByLevel,
      numOfAffectedLevels,
    );
  }

  private aggregate(
    storage: MarketStatisticsStorageService,
  ): AddedItemsByLevel[] {
    const addedItemsCountByLevel =
      new Map<number, number>();

    for (
      let level = 0;
      level <
        MARKET_STATISTICS_LEVEL_CONFIGS.length - 1;
      level += 1
    ) {
      const currentConfig =
        MARKET_STATISTICS_LEVEL_CONFIGS[level];

      const nextConfig =
        MARKET_STATISTICS_LEVEL_CONFIGS[level + 1];

      const startedAt =
        storage.getStartedAt(level);

      const endedAt =
        storage.getEndedAt(level);

      if (
        startedAt === null ||
        endedAt === null
      ) {
        break;
      }

      if (
        endedAt - startedAt <=
        currentConfig.interval +
          nextConfig.duration
      ) {
        break;
      }

      const cutoff =
        endedAt - currentConfig.interval;

      const items =
        storage.readItemsBefore(level, cutoff);

      if (items.length === 0) {
        break;
      }

      const candle =
        this.aggregateCandles(items);

      storage.removeNItems(
        level,
        items.length,
        'should record delta',
      );

      this.refreshAddedItemsCountAfterRemoval(
        addedItemsCountByLevel,
        storage,
        level,
      );

      const targetLevel = level + 1;

      storage.addItem(
        targetLevel,
        candle,
        'should record delta',
      );

      this.incrementAddedItemsCount(
        addedItemsCountByLevel,
        targetLevel,
        1,
      );
    }

    return this.toAddedItemsByLevel(
      addedItemsCountByLevel,
    );
  }

  private applyLiveIndicatorResults(
    event: RecalculateIndicatorsResultsEvent,
  ): void {
    const storage = this.storagesByMarket.get(event.marketName);

    if (!storage) {
      console.error(
        'Cannot apply indicator results: market storage was not found',
        {
          marketName: event.marketName,
          receivedAt: event.receivedAt,
        },
      );

      this.decrementFreezing(event.marketName);
      return;
    }

    try {
      const latestCandle =
        this.getLatestStorageCandle(storage);

      const receivedAtMatches =
        latestCandle?.receivedAt === event.receivedAt;

      const resultsToApply = receivedAtMatches
        ? event.indicators
        : this.createResultsWithEmptyLastValues(
            event.indicators,
          );

      if (!receivedAtMatches) {
        console.error(
          'Cannot apply latest indicator values: receivedAt mismatch',
          {
            marketName: event.marketName,
            expectedReceivedAt:
              latestCandle?.receivedAt ?? null,
            actualReceivedAt: event.receivedAt,
          },
        );
      }

      const appliedIndicatorResults = storage.applyIndicatorResults(
        resultsToApply,
      );

      const delta = storage.commitDelta();

      if (delta) {
        eventBus.emit(
          SERVER_EVENT.marketStatisticsStorageChanged,
          {
            marketName: event.marketName,
            delta,
          },
        );
      }

      eventBus.emit(
        SERVER_EVENT.marketStatisticsPersistenceChanged,
        {
          marketName: event.marketName,
          changes: this.toPersistenceChanges(
            storage,
            event.numOfAffectedLevels,
          ),
          latestIndicators:
            this.getLastIndicatorValues(resultsToApply),
          indicatorChanges:
            appliedIndicatorResults.persistenceChanges,
        },
      );
    } finally {
      this.decrementFreezing(event.marketName);
    }
  }

  private handleRecalculateIndicatorsResults(
    event: RecalculateIndicatorsResultsEvent,
  ): void {
    const waiter = this.indicatorResultWaiter;

    if (waiter) {
      this.indicatorResultWaiter = null;
      waiter.resolve(event);
      return;
    }

    this.applyLiveIndicatorResults(event);
  }

  private getLatestStorageCandle(
    storage: MarketStatisticsStorageService,
  ): MarketCandle | null {
    for (
      let level = 0;
      level < storage.getNumOfLevels();
      level += 1
    ) {
      const candle = storage.getLastItem(level);

      if (candle) {
        return candle;
      }
    }

    return null;
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

  private getLastIndicatorValues(
    results: readonly IndicatorResults[],
  ): MarketIndicatorValues {
    return Object.fromEntries(
      results.map((result) => [
        result.indicatorName,
        result.lastResult,
      ]),
    );
  }

  private createResultsWithEmptyLastValues(
    results: readonly IndicatorResults[],
  ): IndicatorResults[] {
    return results.map((result) => ({
      ...result,
      lastResult: null,
    }));
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
    const receivedAt = getMiddleTimestamp(
      startedAt,
      endedAt,
    );

    const open = first.open;
    const close = last.close;

    return {
      receivedAt,
      price: calculateCandlePrice(
        open,
        close,
        high,
        low,
      ),
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

  private async prepareStoragesFromDatabase(): Promise<void> {
    const now = Date.now();

    const cumulativeCutoffs =
      getCumulativeCutoffs(now);

    const maxLevel =
      MARKET_STATISTICS_LEVEL_CONFIGS.length - 1;

    const maxLevelCutoff =
      cumulativeCutoffs[maxLevel];

    const marketNames =
      await marketCandlesDao.getMarketNames();

    const activeMarketNames = new Set(
      globalStateService.getMarketNames(),
    );

    const persistenceBatch:
      RefreshMarketCandlesInput[] = [];

    console.log(
      'Market statistics startup aggregation started',
      {
        markets: marketNames.length,
      },
    );

    const maxMarketIndex =
      marketNames.length - 1;

    let decile = '0';

    for (
      const [index, marketName]
      of marketNames.entries()
    ) {
      const persistenceInput =
        await this.prepareMarketStorage(
          marketName,
          cumulativeCutoffs,
          maxLevel,
          maxLevelCutoff,
        );

      if (persistenceInput) {
        persistenceBatch.push(
          persistenceInput,
        );
      }

      if (
        persistenceBatch.length >=
        STARTUP_PERSISTENCE_MARKETS_PER_BATCH
      ) {
        await marketCandlesDao.refreshBatch(
          persistenceBatch,
        );

        persistenceBatch.length = 0;
      }

      if (!activeMarketNames.has(marketName)) {
        this.removeMarketStorage(
          marketName,
        );
      }

      const currentDecile = (
        index * 10 / maxMarketIndex
      ).toFixed();

      if (currentDecile !== decile) {
        decile = currentDecile;

        console.log(
          `processed: ${currentDecile}/10`,
        );
      }
    }

    if (persistenceBatch.length > 0) {
      await marketCandlesDao.refreshBatch(
        persistenceBatch,
      );
    }

    console.log(
      'Market statistics startup aggregation finished',
      {
        storages: this.storagesByMarket.size,
      },
    );
  }

private async prepareMarketStorage(
  marketName: string,
  cumulativeCutoffs: readonly number[],
  maxLevel: number,
  maxLevelCutoff: number,
): Promise<RefreshMarketCandlesInput | null> {
    const rows = await marketCandlesDao.getForStartup(
      marketName,
      maxLevel,
      maxLevelCutoff,
    );

    if (rows.length === 0) {
      return null;
    }

    const storage = this.getOrCreateStorage(marketName);

    storage.restoreAllItemsByLevel(
      this.toFullMarketStatisticsLevels(rows),
    );

    const promotionResult =
      this.promoteStartupStorage(
        storage,
        marketName,
        cumulativeCutoffs,
      );

  const indicatorPersistenceChanges =
    await this.recalculateStartupIndicators(
      storage,
      promotionResult.addedItemsByLevel,
    );

    /*
    * Clear the accumulated binary delta, but do not publish it.
    * Clients will receive the final storage through full sync.
    */
    storage.commitDelta();

    return {
      toAdd: promotionResult.addedRows,

      toChange:
        indicatorPersistenceChanges.map(
          (change) => ({
            marketName,
            ...change,
          }),
        ),

      toRemove: promotionResult.removals,
    };
  }

  private toFullMarketStatisticsLevels(
    rows: readonly MarketCandleRow[],
  ): FullMarketStatisticsLevel[] {
    const levels =
      MARKET_STATISTICS_LEVEL_CONFIGS.map(() => ({
        candles: [],
        indicators: [],
      } as FullMarketStatisticsLevel));

    for (const row of rows) {
      const levelData = levels[row.level];

      if (!levelData) {
        throw new Error(
          `Unknown market statistics level from DB: ${row.level}`,
        );
      }

      levelData.candles.push({
        receivedAt: row.receivedAt,
        price: row.price,
        speed: row.speed,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        open: row.open,
        close: row.close,
        high: row.high,
        low: row.low,
      });

      levelData.indicators.push(row.indicators);
    }

    return levels;
  }

  private promoteStartupStorage(
    storage: MarketStatisticsStorageService,
    marketName: string,
    cumulativeCutoffs: readonly number[],
  ): StartupPromotionResult {
    const addedRows: MarketCandleRow[] = [];
    const removals: MarketCandleRemoveRow[] = [];

    const addedItemsCountByLevel =
      new Map<number, number>();

    const maxLevel =
      MARKET_STATISTICS_LEVEL_CONFIGS.length - 1;

    for (
      let sourceLevel = 0;
      sourceLevel < maxLevel;
      sourceLevel += 1
    ) {
      const cutoff =
        cumulativeCutoffs[sourceLevel];

      const sourceItems =
        storage.readItemsBefore(
          sourceLevel,
          cutoff,
        );

      if (sourceItems.length === 0) {
        continue;
      }

      const targetLevel = sourceLevel + 1;

      const targetDuration =
        MARKET_STATISTICS_LEVEL_CONFIGS[
          targetLevel
        ].duration;

      const targetCandles =
        this.aggregateCandlesByDuration(
          sourceItems,
          targetDuration,
        );

      storage.removeNItems(
        sourceLevel,
        sourceItems.length,
        'should record delta',
      );

      this.refreshAddedItemsCountAfterRemoval(
        addedItemsCountByLevel,
        storage,
        sourceLevel,
      );

      for (const candle of targetCandles) {
        storage.addItem(
          targetLevel,
          candle,
          'should record delta',
        );

        addedRows.push({
          marketName,
          level: targetLevel,
          ...candle,
          indicators: {},
        });
      }

      this.incrementAddedItemsCount(
        addedItemsCountByLevel,
        targetLevel,
        targetCandles.length,
      );

      removals.push({
        marketName,
        level: sourceLevel,
        timeThreshold: cutoff,
      });
    }

    /*
    * Old candles of the maximum level were deliberately not loaded.
    * This deletion removes them directly from the database.
    */
    removals.push({
      marketName,
      level: maxLevel,
      timeThreshold:
        cumulativeCutoffs[maxLevel],
    });

    return {
      addedRows,
      removals,
      addedItemsByLevel:
        this.toAddedItemsByLevel(
          addedItemsCountByLevel,
        ),
    };
  }

  private aggregateCandlesByDuration(
    candles: readonly MarketCandle[],
    targetDuration: number,
  ): MarketCandle[] {
    const result: MarketCandle[] = [];

    let bucket: MarketCandle[] = [];
    let bucketStartedAt: number | null = null;

    for (const candle of candles) {
      if (bucketStartedAt === null) {
        bucketStartedAt = candle.startedAt;
      }

      if (
        bucket.length > 0 &&
        candle.startedAt - bucketStartedAt >= targetDuration
      ) {
        result.push(
          this.aggregateCandles(bucket),
        );

        bucket = [];
        bucketStartedAt = candle.startedAt;
      }

      bucket.push(candle);
    }

    if (bucket.length > 0) {
      result.push(
        this.aggregateCandles(bucket),
      );
    }

    return result;
  }

  private async recalculateStartupIndicators(
    storage: MarketStatisticsStorageService,
    addedItemsByLevel:
      readonly AddedItemsByLevel[],
  ): Promise<CandleIndicatorsChange[]> {
    if (addedItemsByLevel.length === 0) {
      return [];
    }

    const resultPromise =
      this.waitForIndicatorResults();

    this.emitRecalculateIndicatorsRequest(
      storage,
      addedItemsByLevel,
      storage.getNumOfLevels(),
    );

    const resultEvent =
      await resultPromise;

    const appliedResults =
      storage.applyIndicatorResults(
        resultEvent.indicators,
      );

    return appliedResults.persistenceChanges;
  }

  private removeMarketStorage(
    marketName: string,
  ): void {
    if (!this.storagesByMarket.delete(marketName)) {
      return;
    }

    this.tickBuffersByMarket.delete(marketName);
    this.freezingByMarket.delete(marketName);

    eventBus.emit(
      SERVER_EVENT.marketRemoved,
      {
        marketName,
      },
    );
  }

  private getOrCreateStorage(
    marketName: string,
  ): MarketStatisticsStorageService {
    const existing = this.storagesByMarket.get(marketName);

    if (existing) {
      return existing;
    }

    const created =
      new MarketStatisticsStorageService(marketName);

    this.storagesByMarket.set(marketName, created);

    return created;
  }

  private handleMarketStatisticsRestored(
    event: MarketStatisticsRestoredEvent,
  ): void {
    for (
      const [marketName, levels]
      of Object.entries(event.itemsByMarket)
    ) {
      const storage = this.getOrCreateStorage(marketName);

      storage.restoreAllItemsByLevel(levels);
    }
  }

  private incrementFreezing(
    marketName: string,
  ): void {
    this.freezingByMarket.set(
      marketName,
      (this.freezingByMarket.get(marketName) ?? 0) + 1,
    );
  }

  private decrementFreezing(
    marketName: string,
  ): void {
    const current =
      this.freezingByMarket.get(marketName) ?? 0;

    if (current <= 1) {
      this.freezingByMarket.delete(marketName);
      this.flushTickBuffer(marketName);
      return;
    }

    this.freezingByMarket.set(
      marketName,
      current - 1,
    );
  }

  private flushTickBuffer(
    marketName: string,
  ): void {
    if (this.isFrozen(marketName)) {
      return;
    }

    const buffer = this.getTickBuffer(marketName);

    while (
      buffer.length > 0 &&
      !this.isFrozen(marketName)
    ) {
      const tick = buffer.shift();

      if (!tick) {
        return;
      }

      this.incrementFreezing(marketName);

      try {
        this.tickProcessor(marketName, tick);
      } catch (error) {
        this.decrementFreezing(marketName);
        throw error;
      }
    }
  }

  private isFrozen(
    marketName: string,
  ): boolean {
    return (
      this.freezingByMarket.get(marketName) ?? 0
    ) > 0;
  }

  private getTickBuffer(
    marketName: string,
  ): MarketTick[] {
    let buffer = this.tickBuffersByMarket.get(marketName);

    if (!buffer) {
      buffer = [];
      this.tickBuffersByMarket.set(
        marketName,
        buffer,
      );
    }

    return buffer;
  }

  private emitRecalculateIndicatorsRequest(
    storage: MarketStatisticsStorageService,
    addedItemsByLevel:
      readonly AddedItemsByLevel[] = [],
    numOfAffectedLevels = 1,
  ): void {
    const centralIndexesAsc: number[] = [];

    for (
      const { level, count }
      of addedItemsByLevel
    ) {
      const levelSize = storage.size(level);

      if (
        !Number.isInteger(count) ||
        count < 0 ||
        count > levelSize
      ) {
        throw new Error(
          `Invalid added items count: ` +
          `level ${level}, count ${count}, ` +
          `level size ${levelSize}`,
        );
      }

      const firstAddedLevelOffset =
        levelSize - count;

      for (
        let levelOffset =
          firstAddedLevelOffset;
        levelOffset < levelSize;
        levelOffset += 1
      ) {
        centralIndexesAsc.push(
          storage.getPointIndexAsc(
            level,
            levelOffset,
          ),
        );
      }
    }

    centralIndexesAsc.sort(
      (left, right) => left - right,
    );

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
