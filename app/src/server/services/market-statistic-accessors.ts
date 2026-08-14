import type {
  MarketStatisticsStorageService,
} from '../../shared/services/market-statistics-storage.js';
import {
  globalStateService
} from '../../shared/services/global-state.js';
import type {
  IndicatorValue,
} from '../../shared/types/market-indicators.js';
import type {
  ChangedIndicatorInterval,
  ChangedIndicatorIntervalsByName,
  MarketCandleIndicatorsChange,
} from '../../shared/types/market-statistic-accessors.js';
import type {
  IndicatorProjection,
  MarketCandle,
  MarketDataView,
  ResolvedIndex,
} from '../../shared/types/market-statistics-storage.js';
import { LazyArray } from '../../shared/utilities/lazy-array.js';
import {
  encodeMarketStatisticsIndicatorChanges,
} from '../../shared/utilities/market-statistics-indicator-changes-codec.js';

interface ExtendedResolvedIndex extends ResolvedIndex {
  startedAt: number;
  endedAt: number;
}

export class MarketStatisticAccessors {
  private readonly receivedAt: number;
  private readonly size: number;

  private readonly extendedResolvedIndexes: ExtendedResolvedIndex[];

  private candleLazyArray: LazyArray<MarketCandle> | null = null;

  private indicatorLazyArrays:
    Record<string, LazyArray<IndicatorValue>> = {};

  private marketDataView: MarketDataView | null = null;

  private persistenceChanges: MarketCandleIndicatorsChange[] | null =
    null;

  private changedIndicatorIntervals:
    ChangedIndicatorIntervalsByName | null = null;

  private binaryChanges: ArrayBuffer | null | undefined;

  public constructor(
    private readonly storage: MarketStatisticsStorageService,
  ) {
    this.size = this.storage.size();

    const latestItem = storage.getLatestItem();

    if (!latestItem) {
      throw new Error(
        `Market "${storage.getMarketName()}" storage is empty`,
      );
    }

    this.receivedAt = latestItem.receivedAt;

    this.extendedResolvedIndexes = new Array(this.size);
  }

  public getMarketDataView(): MarketDataView {
    if (this.marketDataView) {
      return this.marketDataView;
    }

    this.candleLazyArray = new LazyArray({
      getItem: this.storage.getCandleByFlatAscIndex.bind(this.storage),
      setItem: null,
      name: 'Candles',
      size: this.size,
    });

    const getIndicator = (name: string) =>
      (flatAscIndex: number) =>
        this.storage.getIndicatorByFlatAscIndex(name, flatAscIndex);

    const setIndicator = (name: string) =>
      (flatAscIndex: number, value: IndicatorValue) =>
        this.storage.setIndicatorByFlatAscIndex(
          name,
          flatAscIndex,
          value
        );

    for (const name of globalStateService.getAllIndicatorNames()) {
      this.indicatorLazyArrays[name] = new LazyArray({
        getItem: getIndicator(name),
        setItem: setIndicator(name),
        name,
        size: this.size,
      });
    }

    const ascendingIndicators =
      Object.entries(this.indicatorLazyArrays)
        .reduce<IndicatorProjection>((result, [name, lazyArray]) => {
          result[name] = lazyArray.getProxy('ascending');
          return result;
        }, {});

    const descendingIndicators =
      Object.entries(this.indicatorLazyArrays)
        .reduce<IndicatorProjection>((result, [name, lazyArray]) => {
          result[name] = lazyArray.getProxy('descending');
          return result;
        }, {});

    this.marketDataView = {
      receivedAt: this.receivedAt,
      marketName: this.storage.getMarketName(),
      ascending: {
        candles: this.candleLazyArray.getProxy('ascending'),
        indicators: ascendingIndicators,
      },
      descending: {
        candles: this.candleLazyArray.getProxy('descending'),
        indicators: descendingIndicators,
      },
    };

    return this.marketDataView;
  }

  public createPersistenceChanges(
    receivedAt: number,
  ): MarketCandleIndicatorsChange[] {
    this.checkStorageConsistence(receivedAt);

    if (this.persistenceChanges) {
      return this.persistenceChanges;
    }

    const marketName = this.storage.getMarketName();

    const changesByFlatAscIndex =
      new Map<number, MarketCandleIndicatorsChange>();

    for (const [indicatorName, lazyArray] of
      Object.entries(this.indicatorLazyArrays)) {
      const { changedIntervals, cache } = lazyArray.getCachedResults();

      for (const [startFlatAscIndex, count] of changedIntervals) {
        const endFlatAscIndex = startFlatAscIndex + count;

        for (
          let flatAscIndex = startFlatAscIndex;
          flatAscIndex < endFlatAscIndex;
          flatAscIndex++
        ) {
          const existing = changesByFlatAscIndex.get(flatAscIndex);

          if (existing) {
            existing.indicators[indicatorName] = cache[flatAscIndex];
            continue;
          }

          const { level, startedAt, endedAt } =
            this.getExtendedResolvedIndex(flatAscIndex);

          changesByFlatAscIndex.set(flatAscIndex, {
            marketName,
            level,
            startedAt,
            endedAt,
            indicators: {
              [indicatorName]: cache[flatAscIndex],
            },
          });
        }
      }
    }

    this.persistenceChanges = Array.from(
      changesByFlatAscIndex.values(),
    );

    return this.persistenceChanges;
  }

  public createBinaryChanges(receivedAt: number): ArrayBuffer | null {
    this.checkStorageConsistence(receivedAt);

    if (this.binaryChanges !== undefined) {
      return this.binaryChanges;
    }

    const intervals = this.getChangedIndicatorIntervals();

    this.binaryChanges = encodeMarketStatisticsIndicatorChanges(
      intervals,
      globalStateService.getIndicatorRegistry(),
      this.storage.indicatorChunkAccessor,
    );

    return this.binaryChanges;
  }

  private getChangedIndicatorIntervals():
    ChangedIndicatorIntervalsByName {
    if (this.changedIndicatorIntervals) {
      return this.changedIndicatorIntervals;
    }

    const result: ChangedIndicatorIntervalsByName = new Map();

    for (const [indicatorName, lazyArray] of
      Object.entries(this.indicatorLazyArrays)) {
      const { changedIntervals } = lazyArray.getCachedResults();

      if (changedIntervals.length === 0) {
        continue;
      }

      const physicalIntervals: ChangedIndicatorInterval[] = [];

      for (const [startFlatAscIndex, count] of changedIntervals) {
        this.appendPhysicalIntervals(
          physicalIntervals,
          startFlatAscIndex,
          count,
        );
      }

      if (physicalIntervals.length > 0) {
        result.set(indicatorName, physicalIntervals);
      }
    }

    this.changedIndicatorIntervals = result;

    return result;
  }

  private appendPhysicalIntervals(
    result: ChangedIndicatorInterval[],
    startFlatAscIndex: number,
    count: number,
  ): void {
    let flatAscIndex = startFlatAscIndex;
    let remaining = count;

    while (remaining > 0) {
      const resolved = this.getExtendedResolvedIndex(flatAscIndex);

      const availableInChunk =
        resolved.chunk.end - resolved.itemIndex;

      if (availableInChunk <= 0) {
        throw new Error(
          `Invalid resolved chunk position at flat ascending index ` +
          `${flatAscIndex}`,
        );
      }

      const itemCount = Math.min(remaining, availableInChunk);

      result.push({
        level: resolved.level,
        chunkIndex: resolved.chunkIndex,
        itemIndex: resolved.itemIndex,
        itemCount,
      });

      flatAscIndex += itemCount;
      remaining -= itemCount;
    }
  }

  private getExtendedResolvedIndex(
    flatAscIndex: number,
  ): ExtendedResolvedIndex {
    if (flatAscIndex in this.extendedResolvedIndexes) {
      return this.extendedResolvedIndexes[flatAscIndex];
    }

    const resolvedIndex =
      this.storage.resolveFlatAscIndex(flatAscIndex);

    const candle = this.candleLazyArray?.getCache()[flatAscIndex];

    const candleInterval = candle ??
      this.storage.getCandleFieldsByResolvedIndex(
        resolvedIndex,
        'startedAt',
        'endedAt',
      );

    const extendedIndex: ExtendedResolvedIndex = {
      ...resolvedIndex,
      startedAt: candleInterval.startedAt,
      endedAt: candleInterval.endedAt,
    };

    this.extendedResolvedIndexes[flatAscIndex] = extendedIndex;

    return extendedIndex;
  }

  private checkStorageConsistence(receivedAt: number): void {
    const currentReceivedAt =
      this.storage.getLatestItem()?.receivedAt;

    if (
      this.storage.size() !== this.size ||
      currentReceivedAt !== this.receivedAt
    ) {
      throw new Error(
        `Market "${this.storage.getMarketName()}" ` +
        `storage has been changed`,
      );
    }

    if (receivedAt !== this.receivedAt) {
      throw new Error(
        `receivedAt mismatch for market ` +
        `"${this.storage.getMarketName()}": ` +
        `expected ${this.receivedAt}, received ${receivedAt}`,
      );
    }
  }
}
