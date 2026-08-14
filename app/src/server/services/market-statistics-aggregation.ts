// app/src/server/services/market-statistics-aggregation.ts
import {
  MARKET_STATISTICS_LEVEL_CONFIGS,
} from '../../shared/constants/market-statistics-config.js';
import {
  MarketStatisticsStorageService,
} from '../../shared/services/market-statistics-storage.js';
import type {
  AggregatedIndicators,
  AggregatedItemDescriptor,
  CandleIndicatorsChange,
  FullMarketStatisticsLevel,
  MarketCandle,
} from '../../shared/types/market-statistics-storage.js';
import { SERVER_EVENT } from '../constants/events.js';
import {
  MarketCandleAddRow,
  MarketCandlesAddedRemovedInput,
  marketCandlesDao,
  type MarketCandleRemoveRow,
  type MarketCandleRow,
} from '../dao/market-candles.js';
import type {
  MarketStatisticsPersistenceChange,
  MarketStatisticsRestoredEvent,
  MarketTickReceivedEvent,
  IndicatorsRecalculatedEvent,
} from '../types/events.js';
import type { MarketTick } from '../types/market-statistics.js';
import { calculateSpeed } from '../utilities/price.js';
import { getMiddleTimestamp } from '../utilities/time.js';
import { getCumulativeCutoffs } from '../../shared/utilities/time.js';
import { eventBus } from './event-bus.js';
import {
  globalStateService,
} from '../../shared/services/global-state.js';
import {
  calculateTimeDerivative,
} from '../utilities/derivative-integral.js';
import { Freezing } from '../utilities/freezing.js';
import { Awaiters } from '../../shared/utilities/awaiters.js';
import {
  MarketCandleIndicatorsChange
} from '../../shared/types/market-statistic-accessors.js';
import { MarketStatisticAccessors } from './market-statistic-accessors.js';

interface StartupLevelPromotionResult {
  addedRows: MarketCandleAddRow[];
  removal: MarketCandleRemoveRow;
  aggregatedLevel: AggregatedLevelResult;
}

interface StartupPersistenceResult {
  addedRemoved: MarketCandlesAddedRemovedInput;
  indicatorChanges: MarketCandleIndicatorsChange[];
}

interface AggregatedLevelResult {
  level: number;
  items: AggregatedItemResult[];
}

interface AggregatedItemResult {
  removedCandles: MarketCandle[];
  removedIndicators: AggregatedIndicators;
}

interface StartupAggregationResult {
  candle: MarketCandle;
  removedCandles: MarketCandle[];
  removedIndicators: AggregatedIndicators;
}

const STARTUP_PERSISTENCE_MARKETS_PER_BATCH = 20;

export class MarketStatisticsAggregationService {
  private readonly storagesByMarket = new Map<
    string,
    MarketStatisticsStorageService
  >();

  private readonly freezingByMarket: Freezing;

  private readonly tickBuffersByMarket = new Map<string, MarketTick[]>();

  public constructor(
    private indicatorsRecalculatedAwaiters =
      new Awaiters<string, IndicatorsRecalculatedEvent>(),
  ) {
    this.freezingByMarket = new Freezing(
      (marketName: string) => this.flushTickBuffer(marketName),
    );
  }

  public async start(): Promise<void> {
    eventBus.on(
      SERVER_EVENT.indicatorsRecalculated,
      (event) => this.handleIndicatorsRecalculated(event),
    );

    eventBus.on(
      SERVER_EVENT.freezeOnStatisticsStorageNeedsToBeLowered,
      (event) => this.freezingByMarket.warm(event.marketName),
    );

    await globalStateService.waitForIndicatorRegistry();
    await this.startupPrepareStorages();

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

  public createFullSyncSnapshot(
    marketName: string,
  ): FullMarketStatisticsLevel[] {
    this.freezingByMarket.cool(marketName);

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

    const speed = calculateSpeed(
      previousTick?.receivedAt,
      previousTick?.price,
      receivedAt,
      price,
    );

    return {
      ...newTick,
      speed,
      acceleration: calculateTimeDerivative(
        previousTick?.receivedAt,
        previousTick?.speed,
        receivedAt,
        speed,
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

  private handleTickReceived(event: MarketTickReceivedEvent): void {
    const buffer = this.getTickBuffer(event.marketName);

    if (
      this.freezingByMarket.isFrozen(event.marketName) ||
      buffer.length > 0
    ) {
      buffer.push(event.tick);
      return;
    }

    this.freezingByMarket.cool(event.marketName);

    void this.processLiveTick(event.marketName, event.tick);
  }

  private async processLiveTick(
    marketName: string,
    tick: MarketTick,
  ): Promise<void> {
    try {
      const storage = this.getOrCreateStorage(marketName);
      const candle = this.tickToCandle(storage, tick);
      const previousTick = storage.getLastItem(0);

      if (previousTick?.receivedAt === candle.receivedAt) {
        console.warn('Duplicate tick received', { marketName, candle });
        return;
      }

      storage.addItem(0, candle);

      const aggregatedLevels = this.aggregate(storage);

      this.publishStructuralChanges(storage, aggregatedLevels);

      const accessors = new MarketStatisticAccessors(storage);

      const indicatorPromise =
        this.indicatorsRecalculatedAwaiters.wait(marketName);

      this.emitRecalculateIndicatorsRequest(
        accessors,
        storage,
        aggregatedLevels,
      );

      const result = await indicatorPromise;

      const indicatorPersistenceChanges =
        accessors.createPersistenceChanges(result.receivedAt);

      if (indicatorPersistenceChanges.length > 0) {
        eventBus.emit(
          SERVER_EVENT.marketStatisticsPersistenceChanged,
          {
            indicatorChanged: indicatorPersistenceChanges,
          },
        );
      }

      const binaryChanges =
        accessors.createBinaryChanges(result.receivedAt);

      if (binaryChanges) {
        eventBus.emit(
          SERVER_EVENT.marketStatisticsIndicatorsChanged,
          { marketName, changes: binaryChanges },
        );
      }
    } finally {
      this.freezingByMarket.warm(marketName);
    }
  }

  private aggregate(
    storage: MarketStatisticsStorageService,
  ): AggregatedLevelResult[] {
    const result: AggregatedLevelResult[] = [];

    for (
      let sourceLevel = 0;
      sourceLevel < MARKET_STATISTICS_LEVEL_CONFIGS.length - 1;
      sourceLevel += 1
    ) {
      const currentConfig =
        MARKET_STATISTICS_LEVEL_CONFIGS[sourceLevel];

      const nextConfig =
        MARKET_STATISTICS_LEVEL_CONFIGS[sourceLevel + 1];

      const startedAt = storage.getStartedAt(sourceLevel);

      const endedAt = storage.getEndedAt(sourceLevel);

      if (
        startedAt === null || endedAt === null ||
        endedAt - startedAt <=
          currentConfig.interval + nextConfig.duration
      ) {
        break;
      }

      const cutoff = endedAt - currentConfig.interval;

      const { candles, previousCandle, indicators } =
        storage.readItemsBefore(sourceLevel, cutoff);

      if (candles.length === 0) {
        break;
      }

      const aggregatedCandle = this.aggregateCandles(
        candles,
        previousCandle,
      );

      storage.removeNItems(
        sourceLevel,
        candles.length,
        'should record delta',
      );

      storage.addItem(
        sourceLevel + 1,
        aggregatedCandle,
        'should record delta',
      );

      result.push({
        level: sourceLevel + 1,
        items: [{
          removedCandles: candles,
          removedIndicators: indicators
        }],
      });
    }

    return result;
  }

  private publishStructuralChanges(
    storage: MarketStatisticsStorageService,
    aggregatedLevels: readonly AggregatedLevelResult[],
  ): void {
    const marketName = storage.getMarketName();

    const numOfAffectedLevels = Math.max(
      1,
      ...aggregatedLevels.map(({ level }) => level + 1),
    );

    const delta = storage.commitDelta();

    if (delta) {
      eventBus.emit(
        SERVER_EVENT.marketStatisticsStorageChanged,
        { marketName, delta },
      );
    }

    eventBus.emit(
      SERVER_EVENT.marketStatisticsPersistenceAddedRemoved,
      {
        marketName,
        changes: this.toPersistenceChanges(
          storage,
          numOfAffectedLevels,
        ),
      },
    );
  }

  private handleIndicatorsRecalculated(
    event: IndicatorsRecalculatedEvent,
  ): void {
    this.indicatorsRecalculatedAwaiters.resolve(
      event.marketName,
      event
    );
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
    previousCandle: MarketCandle | null,
  ): MarketCandle {
    if (candles.length === 1) {
      return candles[0];
    }

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

    const firstInterval =
      candles[1].receivedAt - first.receivedAt;

    let previousReceivedAt =
      previousCandle?.receivedAt ??
      first.receivedAt - firstInterval;

    let weightedPrice = 0;
    let weightedSpeed = 0;
    let weightedAcceleration = 0;
    let summaryInterval = 0;

    for (const candle of candles) {
      const interval = candle.receivedAt - previousReceivedAt;

      weightedPrice += candle.price * interval;
      weightedSpeed += candle.speed * interval;
      weightedAcceleration += candle.acceleration * interval;
      summaryInterval += interval;

      previousReceivedAt = candle.receivedAt;
    }

    return {
      receivedAt,
      price: weightedPrice / summaryInterval,
      speed: weightedSpeed / summaryInterval,
      acceleration: weightedAcceleration / summaryInterval,
      startedAt,
      endedAt,
      open: first.open,
      close: last.close,
      high,
      low,
    };
  }

  private async persistStartupBatch(
    batch: readonly StartupPersistenceResult[],
  ): Promise<void> {
    if (batch.length === 0) {
      return;
    }

    const addedRemoved = batch
      .map((item) => item.addedRemoved)
      .filter(
        (item) => item.toAdd.length > 0 || item.toRemove.length > 0,
      );

    if (addedRemoved.length > 0) {
      await marketCandlesDao.applyAddedRemovedBatch(addedRemoved);
    }

    const indicatorChanges = batch.flatMap(
      (item) => item.indicatorChanges,
    );

    if (indicatorChanges.length > 0) {
      await marketCandlesDao.upsertIndicatorChanges(indicatorChanges);
    }
  }

  private async startupPrepareStorages(): Promise<void> {
    const now = Date.now();

    const cumulativeCutoffs = getCumulativeCutoffs(now);

    const maxLevel = MARKET_STATISTICS_LEVEL_CONFIGS.length - 1;

    const maxLevelCutoff = cumulativeCutoffs[maxLevel];

    const marketNames = await marketCandlesDao.getMarketNames();

    const activeMarketNames = new Set(
      globalStateService.getMarketNames(),
    );

    const persistenceBatch: StartupPersistenceResult[] = [];

    console.log(
      'Market statistics startup aggregation started',
      { markets: marketNames.length },
    );

    const maxMarketIndex = marketNames.length - 1;

    let decile = '0';

    for (const [index, marketName] of marketNames.entries()) {
      const persistenceInput =
        await this.startupPrepareMarketStorage(
          marketName,
          cumulativeCutoffs,
          maxLevel,
          maxLevelCutoff,
        );

      if (persistenceInput) {
        persistenceBatch.push(persistenceInput);
      }

      if (
        persistenceBatch.length >=
        STARTUP_PERSISTENCE_MARKETS_PER_BATCH
      ) {
        await this.persistStartupBatch(persistenceBatch);
        persistenceBatch.length = 0;
      }

      if (!activeMarketNames.has(marketName)) {
        this.removeMarketStorage(marketName);
      }

      const currentDecile = (index * 10 / maxMarketIndex).toFixed();

      if (currentDecile !== decile) {
        decile = currentDecile;

        console.log(`processed: ${currentDecile}/10`);
      }
    }

    if (persistenceBatch.length > 0) {
      await this.persistStartupBatch(persistenceBatch);
    }

    console.log(
      'Market statistics startup aggregation finished',
      { storages: this.storagesByMarket.size },
    );
  }

  private async startupPrepareMarketStorage(
    marketName: string,
    cumulativeCutoffs: readonly number[],
    maxLevel: number,
    maxLevelCutoff: number,
  ): Promise<StartupPersistenceResult | null> {
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

    const addedRowsByKey = new Map<string, MarketCandleAddRow>();
    const removals: MarketCandleRemoveRow[] = [];

    const indicatorChangesByKey =
      new Map<string, MarketCandleIndicatorsChange>();

    for (let sourceLevel = 0; sourceLevel < maxLevel; sourceLevel += 1) {
      const promotion = this.promoteStartupLevel(
        storage,
        marketName,
        sourceLevel,
        cumulativeCutoffs[sourceLevel],
      );

      if (!promotion) {
        continue;
      }

      this.removeConsumedStartupChanges(
        sourceLevel,
        promotion.aggregatedLevel,
        addedRowsByKey,
        indicatorChangesByKey,
      );

      for (const row of promotion.addedRows) {
        addedRowsByKey.set(
          this.getStartupCandleKey(
            row.level,
            row.startedAt,
            row.endedAt,
          ),
          row,
        );
      }

      removals.push(promotion.removal);

      const accessors = new MarketStatisticAccessors(storage);

      const indicatorPromise =
        this.indicatorsRecalculatedAwaiters.wait(marketName);

      this.emitRecalculateIndicatorsRequest(
        accessors,
        storage,
        [promotion.aggregatedLevel],
      );

      const result = await indicatorPromise;

      this.mergeStartupIndicatorChanges(
        indicatorChangesByKey,
        accessors.createPersistenceChanges(result.receivedAt),
      );
    }

    removals.push({
      marketName,
      level: maxLevel,
      timeThreshold: cumulativeCutoffs[maxLevel],
    });

    /*
    * Startup clients receive the final storage through full sync.
    * Structural binary changes are not needed.
    */
    storage.clearDelta();

    return {
      addedRemoved: {
        toAdd: Array.from(addedRowsByKey.values()),
        toRemove: removals,
      },
      indicatorChanges: Array.from(indicatorChangesByKey.values()),
    };
  }

  private toFullMarketStatisticsLevels(
    rows: readonly MarketCandleRow[],
  ): FullMarketStatisticsLevel[] {
    const levels = MARKET_STATISTICS_LEVEL_CONFIGS.map(
      () =>
        ({ candles: [], indicators: [] } as FullMarketStatisticsLevel),
    );

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
        acceleration: row.acceleration,
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

  private promoteStartupLevel(
    storage: MarketStatisticsStorageService,
    marketName: string,
    sourceLevel: number,
    cutoff: number,
  ): StartupLevelPromotionResult | null {
    const { candles, previousCandle, indicators } =
      storage.readItemsBefore(sourceLevel, cutoff);

    if (candles.length === 0) {
      return null;
    }

    const targetLevel = sourceLevel + 1;
    const targetConfig =
      MARKET_STATISTICS_LEVEL_CONFIGS[targetLevel];

    if (!targetConfig) {
      throw new Error(
        `Unknown target market statistics level: ${targetLevel}`,
      );
    }

    const aggregatedItems = this.startupAggregateItemsByDuration(
      candles,
      previousCandle,
      indicators,
      targetConfig.duration,
    );

    storage.removeNItems(
      sourceLevel,
      candles.length,
      'should record delta',
    );

    const addedRows: MarketCandleAddRow[] = [];

    const aggregatedLevel: AggregatedLevelResult = {
      level: targetLevel,
      items: [],
    };

    for (const aggregated of aggregatedItems) {
      storage.addItem(
        targetLevel,
        aggregated.candle,
        'should record delta',
      );

      addedRows.push({
        marketName,
        level: targetLevel,
        ...aggregated.candle,
      });

      aggregatedLevel.items.push({
        removedCandles: aggregated.removedCandles,
        removedIndicators: aggregated.removedIndicators,
      });
    }

    return {
      addedRows,
      removal: {
        marketName,
        level: sourceLevel,
        timeThreshold: cutoff,
      },
      aggregatedLevel,
    };
  }

  private getStartupCandleKey(
    level: number,
    startedAt: number,
    endedAt: number,
  ): string {
    return `${level}:${startedAt}:${endedAt}`;
  }

  private mergeStartupIndicatorChanges(
    target: Map<string, MarketCandleIndicatorsChange>,
    changes: readonly MarketCandleIndicatorsChange[],
  ): void {
    for (const change of changes) {
      const key = this.getStartupCandleKey(
        change.level,
        change.startedAt,
        change.endedAt,
      );

      const existing = target.get(key);

      if (existing) {
        Object.assign(existing.indicators, change.indicators);
        continue;
      }

      target.set(key, change);
    }
  }

  private removeConsumedStartupChanges(
    sourceLevel: number,
    aggregatedLevel: AggregatedLevelResult,
    addedRowsByKey: Map<string, MarketCandleAddRow>,
    indicatorChangesByKey:
      Map<string, MarketCandleIndicatorsChange>,
  ): void {
    for (const item of aggregatedLevel.items) {
      for (const candle of item.removedCandles) {
        const key = this.getStartupCandleKey(
          sourceLevel,
          candle.startedAt,
          candle.endedAt,
        );

        addedRowsByKey.delete(key);
        indicatorChangesByKey.delete(key);
      }
    }
  }

  private startupAggregateItemsByDuration(
    candles: readonly MarketCandle[],
    previousCandle: MarketCandle | null,
    indicators: AggregatedIndicators,
    targetDuration: number,
  ): StartupAggregationResult[] {
    const indicatorNames = Object.keys(indicators);

    const result: StartupAggregationResult[] = [];

    let candlesToAggregate: MarketCandle[] = [];
    let indicatorsToAggregate = this.getEmptyIndicators(indicatorNames);

    const lastIndex = candles.length - 1;

    let aggregateEndedAt = candles[lastIndex].endedAt;

    for (let index = lastIndex; index >= 0; index--) {
      const currentCandle = candles[index];
      candlesToAggregate.push(currentCandle);

      for (const indicatorName of indicatorNames) {
        indicatorsToAggregate[indicatorName] ??= [];
        indicatorsToAggregate[indicatorName].push(
          indicators[indicatorName][index],
        );
      }

      if (
        aggregateEndedAt - currentCandle.startedAt >= targetDuration ||
        index === 0
      ) {
        const candlesBucket = candlesToAggregate.reverse();
        for (const indicatorName of indicatorNames) {
          indicatorsToAggregate[indicatorName].reverse();
        }

        const candle = this.aggregateCandles(
          candlesBucket,
          result.length === 0 ? previousCandle : candles[index - 1],
        );

        result.push({
          candle,
          removedCandles: candlesBucket,
          removedIndicators: indicatorsToAggregate,
         });

        candlesToAggregate = [];
        indicatorsToAggregate = this.getEmptyIndicators(indicatorNames);
      }
    }

    return result;
  }

  private getEmptyIndicators =
    (indicatorNames: string[]): AggregatedIndicators =>
      indicatorNames.reduce<AggregatedIndicators>(
        (acc, name: string) => {
          acc[name] = [];
          return acc;
        },
        {},
      );

  private removeMarketStorage(
    marketName: string,
  ): void {
    if (!this.storagesByMarket.delete(marketName)) {
      return;
    }

    this.tickBuffersByMarket.delete(marketName);

    eventBus.emit(
      SERVER_EVENT.marketRemoved,
      { marketName },
    );
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
    for (
      const [marketName, levels]
      of Object.entries(event.itemsByMarket)
    ) {
      const storage = this.getOrCreateStorage(marketName);

      storage.restoreAllItemsByLevel(levels);
    }
  }

  private flushTickBuffer(marketName: string): void {
    if (this.freezingByMarket.isFrozen(marketName)) {
      return;
    }

    const buffer = this.getTickBuffer(marketName);
    const tick = buffer.shift();

    if (!tick) {
      return;
    }

    this.freezingByMarket.cool(marketName);

    void this.processLiveTick(marketName, tick);
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
    accessors: MarketStatisticAccessors,
    storage: MarketStatisticsStorageService,
    aggregatedLevels: readonly AggregatedLevelResult[] = [],
  ): void {
    const aggregatedItemDescriptors =
      this.createAggregatedItemDescriptors(
        storage,
        aggregatedLevels,
      );

    eventBus.emit(
      SERVER_EVENT.recalculateIndicatorsRequest,
      {
        ...accessors.getMarketDataView(),
        aggregatedItemDescriptors,
      },
    );
  }

  private createAggregatedItemDescriptors(
    storage: MarketStatisticsStorageService,
    aggregatedLevels: readonly AggregatedLevelResult[],
  ): AggregatedItemDescriptor[] {
    const result: AggregatedItemDescriptor[] = [];

    for (const levelResult of aggregatedLevels) {
      const levelSize = storage.size(levelResult.level);

      const firstAddedLevelOffset =
        levelSize - levelResult.items.length;

      if (firstAddedLevelOffset < 0) {
        throw new Error(
          `Invalid aggregation result for level ${levelResult.level}`,
        );
      }

      for (const [index, aggregated] of levelResult.items.entries()) {
        result.push({
          indexAsc: storage.getFlatAscIndex(
            levelResult.level,
            firstAddedLevelOffset + index,
          ),
          removedCandles: aggregated.removedCandles,
          removedIndicators: aggregated.removedIndicators,
        });
      }
    }

    result.sort((left, right) => left.indexAsc - right.indexAsc);

    return result;
  }
}

export const marketStatisticsAggregationService =
  new MarketStatisticsAggregationService();
