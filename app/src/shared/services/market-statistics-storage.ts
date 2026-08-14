// app/src/shared/services/market-statistics-storage.ts
import {
  MARKET_STATISTICS_LEVEL_CONFIGS,
} from '../constants/market-statistics-config.js';
import {
  MARKET_STATISTICS_DELTA_OPERATION_TYPE,
} from '../constants/market-statistics-storage.js';
import type {
  IndicatorValue,
  MarketIndicatorValues,
} from '../types/market-indicators.js';
import type {
  MarketStatisticsChunk,
  MarketStatisticsDeltaRecordMode,
  MarketCandle,
  MarketStatisticsLevel,
  FullMarketStatisticsLevel,
  AggregatedIndicators,
  ResolvedIndex,
  MarketDataProjectionSnapshot,
} from '../types/market-statistics-storage.js';
import {
  getIndicatorValueByteLength,
  readIndicatorValue,
  writeIndicatorValue,
} from '../utilities/market-indicators-codec.js';
import {
  MARKET_STATISTICS_CANDLE_FIELDS_PER_ITEM,
  readMarketCandleField,
  readMarketCandleFields,
  readMarketCandleFromFloat64Array,
  writeMarketCandleToFloat64Array,
} from '../utilities/market-statistics-codec.js';
import {
  MarketStatisticsDeltaService,
} from './market-statistics-delta.js';
import { globalStateService } from './global-state.js';
import {
  applyMarketStatisticsIndicatorChanges
} from '../utilities/market-statistics-indicator-changes-codec.js';

interface IndicatorStorageChunk {
  data: Uint8Array;
  view: DataView;
}

interface IndicatorStorage {
  codecIndex: number;
  valueByteLength: number;
  chunks: IndicatorStorageChunk[];
}

interface ItemsBeforeCutoff {
  candles: MarketCandle[];
  previousCandle: MarketCandle | null;
  indicators: AggregatedIndicators;
}

export class MarketStatisticsStorageService {
  public constructor(
    private readonly marketName: string,
    private readonly indicatorRegistry =
      globalStateService.getIndicatorRegistry(),
    private readonly allIndicatorNames =
      globalStateService.getAllIndicatorNames(),
    private readonly indicatorsWithPreservedHistory =
      globalStateService.getIndicatorsWithPreservedHistory(),
  ) {
    for (
      let level = 0;
      level < MARKET_STATISTICS_LEVEL_CONFIGS.length;
      level += 1
    ) {
      this.syncIndicatorChunksWithCandleChunks(level);
    }
  }

  private readonly levels: MarketStatisticsLevel[] =
    MARKET_STATISTICS_LEVEL_CONFIGS.map(() => this.createLevel());

  private readonly indicatorStorageByLevel =
    MARKET_STATISTICS_LEVEL_CONFIGS.map(
      () => new Map<string, IndicatorStorage>(),
    );

  private readonly deltaService = new MarketStatisticsDeltaService();

  public readonly indicatorChunkAccessor = (
    indicatorName: string,
    level: number,
    chunkIndex: number,
  ) => this.getIndicatorChunk(indicatorName, level, chunkIndex);

  addItem(
    level: number,
    item: MarketCandle,
    deltaRecordMode: MarketStatisticsDeltaRecordMode = 'should record delta',
  ): void {
    const config = MARKET_STATISTICS_LEVEL_CONFIGS[level];

    if (!config) {
      throw new Error(`Unknown market statistics level: ${level}`);
    }

    const levelStorage = this.levels[level];

    let chunk = levelStorage.chunks.at(-1);

    if (!chunk || chunk.end >= config.chunkCapacity) {
      chunk = this.createChunk(level);
      levelStorage.chunks.push(chunk);
      this.addIndicatorChunk(level);
    }

    writeMarketCandleToFloat64Array(chunk.data, chunk.end, item);

    this.writeEmptyIndicatorsByResolvedIndex(
      level,
      levelStorage.chunks.length - 1,
      chunk.end,
    );

    levelStorage.startedAt ??= item.startedAt;
    levelStorage.endedAt = item.endedAt;

    chunk.end += 1;
    chunk.size += 1;
    levelStorage.size += 1;

    if (deltaRecordMode === 'should record delta') {
      this.deltaService.recordAddItem(level, item);
    }
  }

  removeNItems(
    level: number,
    count: number,
    deltaRecordMode: MarketStatisticsDeltaRecordMode = 'should record delta',
  ): void {
    if (count <= 0) {
      return;
    }

    const levelStorage = this.levels[level];

    if (!levelStorage) {
      throw new Error(`Unknown market statistics level: ${level}`);
    }

    if (count > levelStorage.size) {
      throw new Error(
        `Cannot remove ${count} items from level ` +
        `${level}: level size is ${levelStorage.size}`,
      );
    }

    let remaining = count;

    while (remaining > 0) {
      const chunk = levelStorage.chunks[0];

      if (!chunk) {
        throw new Error(
          `Cannot remove ${count} items from level ${level}: ` +
          `storage is empty`,
        );
      }

      const removed = Math.min(chunk.size, remaining);

      chunk.start += removed;
      chunk.size -= removed;
      levelStorage.size -= removed;
      remaining -= removed;

      if (chunk.size === 0) {
        levelStorage.chunks.shift();
        this.removeFirstIndicatorChunk(level);
      }
    }

    this.refreshLevelBounds(level);

    if (deltaRecordMode === 'should record delta') {
      this.deltaService.recordRemoveItems(level, count);
    }
  }

  commitDelta(): ArrayBuffer | null {
    return this.deltaService.commit();
  }

  clearDelta(): void {
    this.deltaService.clear();
  }

  applyDelta(delta: Uint8Array): void {
    const operations = this.deltaService.decode(delta);

    for (const operation of operations) {
      if (
        operation.type === MARKET_STATISTICS_DELTA_OPERATION_TYPE.addItem
      ) {
        this.addItem(
          operation.level,
          operation.item,
          'suppress record delta',
        );

        continue;
      }

      this.removeNItems(
        operation.level,
        operation.count,
        'suppress record delta',
      );
    }
  }

  applyIndicatorChanges(buffer: Uint8Array): void {
    applyMarketStatisticsIndicatorChanges(
      buffer,
      this.indicatorRegistry,
      this.indicatorChunkAccessor,
    );
  }

  getAllItemsByLevel(): FullMarketStatisticsLevel[] {
    return this.levels.map((levelStorage, level) => {
      const candles: MarketCandle[] = [];
      const indicators: MarketIndicatorValues[] = [];

      for (
        let chunkIndex = 0;
        chunkIndex < levelStorage.chunks.length;
        chunkIndex += 1
      ) {
        const chunk = levelStorage.chunks[chunkIndex];

        for (
          let itemIndex = chunk.start;
          itemIndex < chunk.end;
          itemIndex += 1
        ) {
          candles.push(
            readMarketCandleFromFloat64Array(chunk.data, itemIndex),
          );

          indicators.push(
            this.readIndicatorsByResolvedIndex(
              level,
              chunkIndex,
              itemIndex,
            ),
          );
        }
      }

      return {
        candles,
        indicators,
      };
    });
  }

  restoreAllItemsByLevel(
    levels: readonly FullMarketStatisticsLevel[],
  ): void {
    for (const [level, data] of levels.entries()) {
      if (data.candles.length !== data.indicators.length) {
        throw new Error(
          `Cannot restore market statistics level ${level}: ` +
          `candles length ${data.candles.length} does not match ` +
          `indicators length ${data.indicators.length}`,
        );
      }

      for (
        let itemIndex = 0;
        itemIndex < data.candles.length;
        itemIndex += 1
      ) {
        const candle = data.candles[itemIndex];
        const indicators = data.indicators[itemIndex];

        this.addItem(
          level,
          candle,
          'suppress record delta',
        );

        this.addIndicators(
          candle.receivedAt,
          indicators,
          level,
        );
      }
    }

    this.deltaService.clear();
  }

  getNumOfLevels(): number {
    return this.levels.length;
  }

  getStartedAt(level: number): number | null {
    return this.levels[level]?.startedAt ?? null;
  }

  getEndedAt(level: number): number | null {
    return this.levels[level]?.endedAt ?? null;
  }

  getLastItem(level: number = 0): MarketCandle | null {
    const levelStorage = this.levels[level];

    if (!levelStorage || levelStorage.size === 0) {
      return null;
    }

    const chunk = levelStorage.chunks.at(-1);

    if (!chunk || chunk.size === 0) {
      return null;
    }

    return readMarketCandleFromFloat64Array(chunk.data, chunk.end - 1);
  }

  getLatestItem(): MarketCandle | null {
    let latestItem: MarketCandle | null = null;

    for (let level = 0; level < this.levels.length; level += 1) {
      const item = this.getLastItem(level);

      if (
        item &&
        (!latestItem || item.receivedAt > latestItem.receivedAt)
      ) {
        latestItem = item;
      }
    }

    return latestItem;
  }

  readItemsBefore(
    level: number,
    cutoff: number,
  ): ItemsBeforeCutoff {
    const levelStorage = this.levels[level];
    const config = MARKET_STATISTICS_LEVEL_CONFIGS[level];

    if (!levelStorage || !config || levelStorage.size === 0) {
      return { candles: [], previousCandle: null, indicators: {} };
    }

    const candles: MarketCandle[] = [];

    const indicators = this.indicatorsWithPreservedHistory.reduce(
      (acc, indicatorName) => {
        acc[indicatorName] = [];
        return acc;
      },
      {} as Record<string, IndicatorValue[]>,
    );

    const previousCandle = this.getLastItem(level + 1);

    for (const [chunkIndex, chunk] of levelStorage.chunks.entries()) {
      if (chunk.size === 0) {
        continue;
      }

      for (
        let itemIndex = chunk.start;
        itemIndex < chunk.end;
        itemIndex += 1
      ) {
        const candle = readMarketCandleFromFloat64Array(
          chunk.data,
          itemIndex,
        );

        if (candle.endedAt >= cutoff) {
          this.checkIndicatorsConsistence(indicators, candles.length);

          return { candles, indicators, previousCandle };
        }

        candles.push(candle);

        for (
          const indicatorName of this.indicatorsWithPreservedHistory
        ) {
          indicators[indicatorName].push(
            this.readIndicatorByResolvedIndex(
              level,
              chunkIndex,
              itemIndex,
              indicatorName,
            ),
          );
        }
      }
    }

    this.checkIndicatorsConsistence(indicators, candles.length);

    return {
      candles,
      indicators,
      previousCandle,
    };
  }

  size(level?: number): number {
    if (typeof level === 'number') {
      return this.levels[level]?.size ?? 0;
    }

    return this.levels.reduce(
      (sum, levelStorage) => sum + levelStorage.size,
      0,
    );
  }

  getFlatAscIndex(
    level: number,
    levelOffset: number,
  ): number {
    const levelStorage = this.levels[level];

    if (!levelStorage) {
      throw new Error(
        `Unknown market statistics level: ${level}`,
      );
    }

    if (
      !Number.isInteger(levelOffset) ||
      levelOffset < 0 ||
      levelOffset >= levelStorage.size
    ) {
      throw new Error(
        `Market statistics level offset out of range: ` +
        `level ${level}, offset ${levelOffset}`,
      );
    }

    let flatAscIndex = levelOffset;

    for (
      let currentLevel = level + 1;
      currentLevel < this.levels.length;
      currentLevel += 1
    ) {
      flatAscIndex += this.levels[currentLevel].size;
    }

    return flatAscIndex;
  }

  createIntervalProjection(
    interval: number,
    now: number = Date.now(),
  ): MarketDataProjectionSnapshot {
    const cutoff = now - interval;

    const candles: MarketCandle[] = [];
    const indicators: MarketIndicatorValues[] = [];

    let isStarted = false;

    for (let level = this.levels.length - 1; level >= 0; level -= 1) {
      const levelStorage = this.levels[level];

      if (levelStorage.size === 0) {
        continue;
      }

      if (!isStarted) {
        if (
          levelStorage.endedAt !== null &&
          levelStorage.endedAt < cutoff
        ) {
          continue;
        }

        if (
          levelStorage.startedAt !== null &&
          levelStorage.startedAt >= cutoff
        ) {
          isStarted = true;
        }
      }

      for (
        let chunkIndex = 0;
        chunkIndex < levelStorage.chunks.length;
        chunkIndex += 1
      ) {
        const chunk = levelStorage.chunks[chunkIndex];

        if (chunk.size === 0) {
          continue;
        }

        let startItemIndex = chunk.start;

        if (!isStarted) {
          const lastReceivedAt = readMarketCandleField(
            chunk.data,
            chunk.end - 1,
            'receivedAt',
          );

          if (lastReceivedAt < cutoff) {
            continue;
          }

          startItemIndex = this.findFirstItemAtOrAfter(
            chunk,
            cutoff,
          );

          isStarted = true;
        }

        for (
          let itemIndex = startItemIndex;
          itemIndex < chunk.end;
          itemIndex += 1
        ) {
          candles.push(
            readMarketCandleFromFloat64Array(chunk.data, itemIndex),
          );

          indicators.push(
            this.readIndicatorsByResolvedIndex(
              level,
              chunkIndex,
              itemIndex,
            ),
          );
        }
      }
    }

    return { candles, indicators };
  }

  resolveFlatAscIndex(index: number): ResolvedIndex {
    let rest = index;

    for (let level = this.levels.length - 1; level >= 0; level -= 1) {
      const levelStorage = this.levels[level];

      if (rest >= levelStorage.size) {
        rest -= levelStorage.size;
        continue;
      }

      let levelOffset = 0;

      for (
        let chunkIndex = 0;
        chunkIndex < levelStorage.chunks.length;
        chunkIndex += 1
      ) {
        const chunk = levelStorage.chunks[chunkIndex];

        if (rest < chunk.size) {
          return {
            level,
            levelOffset: levelOffset + rest,
            chunk,
            chunkIndex,
            itemIndex: chunk.start + rest,
          };
        }

        rest -= chunk.size;
        levelOffset += chunk.size;
      }
    }

    throw new Error(`Market statistics item index out of range: ${index}`);
  }

  getCandleByFlatAscIndex(index: number): MarketCandle {
    return this.readCandleByResolvedIndex(
      this.resolveFlatAscIndex(index),
    );
  }

  setCandleByFlatAscIndex(
    index: number,
    candle: MarketCandle
  ): MarketCandle {
    const { level, chunkIndex, itemIndex } =
      this.resolveFlatAscIndex(index);

    const chunk = this.levels[level]?.chunks[chunkIndex]?.data;
    if (!chunk) {
      throw new Error(`Chunk not found`);
    }

    writeMarketCandleToFloat64Array(chunk, itemIndex, candle);

    return candle;
  }

  getIndicatorByFlatAscIndex(
    indicatorName: string,
    index: number,
  ): IndicatorValue {
    const { level, chunkIndex, itemIndex } =
      this.resolveFlatAscIndex(index);

    return this.readIndicatorByResolvedIndex(
      level,
      chunkIndex,
      itemIndex,
      indicatorName,
    );
  }

  setIndicatorByFlatAscIndex(
    name: string,
    index: number,
    value: IndicatorValue,
  ): IndicatorValue {
    const { level, chunkIndex, itemIndex } =
      this.resolveFlatAscIndex(index);

    return this.writeIndicatorByResolvedIndex(
      level,
      chunkIndex,
      itemIndex,
      name,
      value
    );
  }

  getMarketName(): string {
    return this.marketName;
  }

  getCandleFieldsByResolvedIndex<
    const TFieldNames extends readonly (keyof MarketCandle)[],
  >(
    resolvedIndex: ResolvedIndex,
    ...fieldNames: TFieldNames
  ): Pick<MarketCandle, TFieldNames[number]> {
    return readMarketCandleFields(
      resolvedIndex.chunk.data,
      resolvedIndex.itemIndex,
      ...fieldNames,
    );
  }

  getIndicatorChunk(
    name: string,
    level: number,
    chunkIndex: number): Uint8Array<ArrayBufferLike> {

    const chunk =
      this.indicatorStorageByLevel[level]
        ?.get(name)?.chunks[chunkIndex]?.data;

    if (!chunk) {
      throw new Error(
        `Chunk not found for indicator "${name}", level: ${level}, ` +
        `chunkIndex: ${chunkIndex}`,
      );
    }

    return chunk;
  }

  private addIndicators(
    receivedAt: number,
    indicators: MarketIndicatorValues,
    level = 0,
  ): boolean {
    const resolvedIndex = this.getResolvedIndexOfLastItem(level);

    if (!resolvedIndex) {
      console.error('Cannot add market indicators: level is empty', {
        marketName: this.marketName,
        level,
        receivedAt,
        indicators,
      });

      return false;
    }

    const isReceivedAtMatching =
      resolvedIndex.item.receivedAt === receivedAt;

    const indicatorsToWrite = isReceivedAtMatching
      ? this.normalizeIndicatorValues(indicators)
      : this.createEmptyIndicators();

    if (!isReceivedAtMatching) {
      console.error(
        'Cannot add market indicators: receivedAt mismatch',
        {
          marketName: this.marketName,
          level,
          expectedReceivedAt: resolvedIndex.item.receivedAt,
          actualReceivedAt: receivedAt,
          indicators,
        }
      );
    }

    this.writeIndicatorsByResolvedIndex(
      resolvedIndex.level,
      resolvedIndex.chunkIndex,
      resolvedIndex.itemIndex,
      indicatorsToWrite,
    );

    return isReceivedAtMatching;
  }

  private writeIndicatorAtLevelOffset(
    level: number,
    levelOffset: number,
    indicatorName: string,
    value: IndicatorValue,
  ): void {
    const position = this.resolveLevelOffset(level, levelOffset);

    this.writeIndicatorByResolvedIndex(
      level,
      position.chunkIndex,
      position.itemIndex,
      indicatorName,
      value,
    );
  }

  private resolveLevelOffset(
    level: number,
    levelOffset: number,
  ): {
    chunkIndex: number;
    itemIndex: number;
  } {
    const levelStorage = this.levels[level];

    if (!levelStorage) {
      throw new Error(`Unknown market statistics level: ${level}`);
    }

    if (
      !Number.isInteger(levelOffset) ||
      levelOffset < 0 ||
      levelOffset >= levelStorage.size
    ) {
      throw new Error(
        `Market statistics level offset out of range: level ${level},` +
        ` offset ${levelOffset}`,
      );
    }

    let rest = levelOffset;

    for (
      let chunkIndex = 0;
      chunkIndex < levelStorage.chunks.length;
      chunkIndex += 1
    ) {
      const chunk = levelStorage.chunks[chunkIndex];

      if (rest < chunk.size) {
        return {
          chunkIndex,
          itemIndex: chunk.start + rest,
        };
      }

      rest -= chunk.size;
    }

    throw new Error(
      `Cannot resolve market statistics level offset: level ${level},` +
      ` offset ${levelOffset}`,
    );
  }

  private writeIndicatorByResolvedIndex(
    level: number,
    chunkIndex: number,
    itemIndex: number,
    indicatorName: string,
    value: IndicatorValue,
  ): IndicatorValue {
    const indicatorStorage =
      this.indicatorStorageByLevel[level]
        ?.get(indicatorName);

    if (!indicatorStorage) {
      console.error(
        'Cannot write unknown indicator',
        {
          marketName: this.marketName,
          indicatorName,
        },
      );

      return null;
    }

    const chunk =
      indicatorStorage.chunks[chunkIndex];

    if (!chunk) {
      throw new Error(
        `Indicator chunk "${indicatorName}" not found ` +
        `for level ${level}, chunk ${chunkIndex}`,
      );
    }

    const result = writeIndicatorValue(
      chunk.view,
      itemIndex *
        indicatorStorage.valueByteLength,
      indicatorStorage.codecIndex,
      value,
    );

    return result.value;
  }

  private readCandleByResolvedIndex(
    resolved: {
      level: number;
      chunk: MarketStatisticsChunk;
      itemIndex: number;
    },
  ): MarketCandle {
    return readMarketCandleFromFloat64Array(
      resolved.chunk.data,
      resolved.itemIndex,
    );
  }

  private getResolvedIndexOfLastItem(
    level: number,
  ): {
    level: number;
    chunkIndex: number;
    itemIndex: number;
    item: MarketCandle;
  } | null {
    const levelStorage = this.levels[level];

    if (!levelStorage || levelStorage.size === 0) {
      return null;
    }

    const chunkIndex = levelStorage.chunks.length - 1;
    const chunk = levelStorage.chunks[chunkIndex];

    if (!chunk || chunk.size === 0) {
      return null;
    }

    const itemIndex = chunk.end - 1;

    return {
      level,
      chunkIndex,
      itemIndex,
      item: readMarketCandleFromFloat64Array(chunk.data, itemIndex),
    };
  }

  private getIndicatorsByFlatAscIndex(
    index: number,
  ): MarketIndicatorValues | null {
    const resolved = this.resolveFlatAscIndex(index);

    return this.readIndicatorsByResolvedIndex(
      resolved.level,
      resolved.chunkIndex,
      resolved.itemIndex,
    );
  }

  private createLevel(): MarketStatisticsLevel {
    return {
      chunks: [],
      size: 0,
      startedAt: null,
      endedAt: null,
    };
  }

  private createChunk(level: number): MarketStatisticsChunk {
    const fieldsPerItem = MARKET_STATISTICS_CANDLE_FIELDS_PER_ITEM;
    const chunkCapacity =
      MARKET_STATISTICS_LEVEL_CONFIGS[level].chunkCapacity;

    return {
      data: new Float64Array(chunkCapacity * fieldsPerItem),
      start: 0,
      end: 0,
      size: 0,
    };
  }

  private addIndicatorChunk(level: number): void {
    const config = MARKET_STATISTICS_LEVEL_CONFIGS[level];

    if (!config) {
      throw new Error(
        `Unknown market statistics level: ${level}`,
      );
    }

    const storageByIndicator =
      this.indicatorStorageByLevel[level];

    for (const indicatorConfig of this.indicatorRegistry) {
      let indicatorStorage =
        storageByIndicator.get(indicatorConfig.name);

      if (!indicatorStorage) {
        indicatorStorage =
          this.createIndicatorStorage(indicatorConfig.codecIndex);

        storageByIndicator.set(indicatorConfig.name, indicatorStorage);
      }

      indicatorStorage.chunks.push(
        this.createIndicatorStorageChunk(
          config.chunkCapacity,
          indicatorStorage.codecIndex,
        ),
      );
    }
  }

  private removeFirstIndicatorChunk(
    level: number,
  ): void {
    const storageByIndicator = this.indicatorStorageByLevel[level];

    for (const indicatorStorage of storageByIndicator.values()) {
      indicatorStorage.chunks.shift();
    }
  }

  private createIndicatorStorage(
    codecIndex: number,
  ): IndicatorStorage {
    return {
      codecIndex,
      valueByteLength: getIndicatorValueByteLength(codecIndex),
      chunks: [],
    };
  }

  private syncIndicatorChunksWithCandleChunks(
    level: number,
  ): void {
    const levelStorage = this.levels[level];
    const levelConfig = MARKET_STATISTICS_LEVEL_CONFIGS[level];

    if (!levelStorage || !levelConfig) {
      throw new Error(
        `Unknown market statistics level: ${level}`,
      );
    }

    const storageByIndicator = this.indicatorStorageByLevel[level];

    for (const indicatorConfig of this.indicatorRegistry) {
      let indicatorStorage =
        storageByIndicator.get(indicatorConfig.name);

      if (
        !indicatorStorage ||
        indicatorStorage.codecIndex !== indicatorConfig.codecIndex
      ) {
        indicatorStorage =
          this.createIndicatorStorage(indicatorConfig.codecIndex);

        storageByIndicator.set(indicatorConfig.name, indicatorStorage);
      }

      while (
        indicatorStorage.chunks.length < levelStorage.chunks.length
      ) {
        indicatorStorage.chunks.push(
          this.createIndicatorStorageChunk(
            levelConfig.chunkCapacity,
            indicatorStorage.codecIndex,
          ),
        );
      }

      if (indicatorStorage.chunks.length > levelStorage.chunks.length) {
        indicatorStorage.chunks.splice(levelStorage.chunks.length);
      }
    }

    const indicatorNames =
      new Set(
        this.indicatorRegistry.map(
          (indicatorConfig) => indicatorConfig.name
        ),
      );

    for (const indicatorName of storageByIndicator.keys()) {
      if (!indicatorNames.has(indicatorName)) {
        storageByIndicator.delete(indicatorName);
      }
    }
  }

  private createIndicatorStorageChunk(
    chunkCapacity: number,
    codecIndex: number,
  ): IndicatorStorageChunk {
    const valueByteLength =
      getIndicatorValueByteLength(codecIndex);

    const data = new Uint8Array(chunkCapacity * valueByteLength);

    const view = new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );

    let offset = 0;

    for (let index = 0; index < chunkCapacity; index += 1) {
      const result = writeIndicatorValue(view, offset, codecIndex, null);
      offset = result.offset;
    }

    return { data, view };
  }

  private refreshLevelBounds(level: number): void {
    const levelStorage = this.levels[level];

    if (levelStorage.size === 0) {
      levelStorage.startedAt = null;
      levelStorage.endedAt = null;
      return;
    }

    const firstChunk = levelStorage.chunks[0];
    const lastChunk = levelStorage.chunks.at(-1);

    if (!firstChunk || !lastChunk) {
      throw new Error(
        `Market statistics level ${level} has size ${
          levelStorage.size
        } but has no chunks`,
      );
    }

    levelStorage.startedAt = readMarketCandleField(
      firstChunk.data,
      firstChunk.start,
      'startedAt',
    );

    levelStorage.endedAt = readMarketCandleField(
      lastChunk.data,
      lastChunk.end - 1,
      'endedAt',
    );
  }

  private readIndicatorsByResolvedIndex(
    level: number,
    chunkIndex: number,
    itemIndex: number,
  ): MarketIndicatorValues {
    const result: MarketIndicatorValues = {};

    for (const indicatorConfig of this.indicatorRegistry) {
      result[indicatorConfig.name] =
        this.readIndicatorByResolvedIndex(
          level,
          chunkIndex,
          itemIndex,
          indicatorConfig.name,
        );
    }

    return result;
  }

  private readIndicatorByResolvedIndex(
    level: number,
    chunkIndex: number,
    itemIndex: number,
    name: string,
  ): IndicatorValue {
    const indicatorStorage =
      this.indicatorStorageByLevel[level]?.get(name);

    if (!indicatorStorage) {
      return null;
    }

    const chunk = indicatorStorage.chunks[chunkIndex];

    if (!chunk) {
      return null;
    }

    return readIndicatorValue(
      chunk.view,
      itemIndex * indicatorStorage.valueByteLength,
      indicatorStorage.codecIndex,
    ).value;
  }

  private createEmptyIndicators(): MarketIndicatorValues {
    return this.normalizeIndicatorValues({});
  }

  private normalizeIndicatorValues(
    values: Readonly<MarketIndicatorValues>,
  ): MarketIndicatorValues {
    const normalized: MarketIndicatorValues = {};

    for (const indicatorConfig of this.indicatorRegistry) {
      normalized[indicatorConfig.name] =
        values[indicatorConfig.name] ?? null;
    }

    return normalized;
  }

  private checkIndicatorsConsistence(
    indicators: AggregatedIndicators,
    expectedLength: number,
  ): void {
    for (const [indicatorName, values] of Object.entries(indicators)) {
      if (values.length !== expectedLength) {
        throw new Error(
          `Indicator "${indicatorName}" history length `
          + `(${values.length}) does not match candles `
          + `(${expectedLength}).`,
        );
      }
    }
  }

  private writeEmptyIndicatorsByResolvedIndex(
    level: number,
    chunkIndex: number,
    itemIndex: number,
  ): void {
    this.writeIndicatorsByResolvedIndex(
      level,
      chunkIndex,
      itemIndex,
      this.createEmptyIndicators(),
    );
  }

  private writeIndicatorsByResolvedIndex(
    level: number,
    chunkIndex: number,
    itemIndex: number,
    indicators: MarketIndicatorValues,
  ): void {
    const normalizedIndicators =
      this.normalizeIndicatorValues(indicators);

    const storageByIndicator =
      this.indicatorStorageByLevel[level];

    if (!storageByIndicator) {
      throw new Error(
        `Unknown market statistics level: ${level}`,
      );
    }

    for (const indicatorConfig of this.indicatorRegistry) {
      const indicatorStorage =
        storageByIndicator.get(indicatorConfig.name);

      const chunk = indicatorStorage?.chunks[chunkIndex];

      if (!indicatorStorage || !chunk) {
        throw new Error(
          `Indicator chunk "${indicatorConfig.name}" not found ` +
          `for level ${level}, chunk ${chunkIndex}`,
        );
      }

      writeIndicatorValue(
        chunk.view,
        itemIndex * indicatorStorage.valueByteLength,
        indicatorStorage.codecIndex,
        normalizedIndicators[indicatorConfig.name],
      );
    }
  }

  private findFirstItemAtOrAfter(
    chunk: MarketStatisticsChunk,
    cutoff: number,
  ): number {
    let left = chunk.start;
    let right = chunk.end;

    while (left < right) {
      const middle = left + Math.floor((right - left) / 2);

      const receivedAt = readMarketCandleField(
        chunk.data,
        middle,
        'receivedAt',
      );

      if (receivedAt < cutoff) {
        left = middle + 1;
      } else {
        right = middle;
      }
    }

    return left;
  }
}
