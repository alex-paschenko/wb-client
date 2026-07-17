// app/src/shared/services/market-statistics-storage.ts
import {
  MARKET_STATISTICS_LEVEL_CONFIGS,
} from '../constants/market-statistics-config.js';

import {
  MARKET_STATISTICS_DELTA_OPERATION_TYPE,
} from '../constants/market-statistics-storage.js';

import type {
  ChangedIndicatorChunk,
  IndicatorResults,
  IndicatorValuesChunk,
  MarketIndicatorValues,
  MarketIndicatorsRegistry,
} from '../types/market-indicators.js';

import type {
  MarketStatisticsChunk,
  MarketStatisticsDeltaRecordMode,
  MarketCandle,
  MarketDataArray,
  MarketDataProjection,
  MarketDataView,
  MarketStatisticsLevel,
  MarketDataProjectionDirection,
  FullMarketStatisticsLevel,
  MarketDataProjectionSnapshot,
  AppliedIndicatorResults,
  CandleIndicatorsChange,
} from '../types/market-statistics-storage.js';

import {
  getIndicatorValueByteLength,
  readIndicatorValue,
  writeIndicatorValue,
} from '../utilities/market-indicators-codec.js';

import {
  getMarketStatisticsFieldsPerItem,
  getMarketCandleByteLength,
  readMarketCandleFromDataView,
  readMarketCandleFromFloat64Array,
  writeMarketCandleToDataView,
  writeMarketCandleToFloat64Array,
} from '../utilities/market-statistics-codec.js';
import { globalStateService } from './global-state.js';

type DeltaOperation =
  | {
      type: typeof MARKET_STATISTICS_DELTA_OPERATION_TYPE.addItem;
      level: number;
      item: MarketCandle;
      indicators: MarketIndicatorValues | null;
    }
  | {
      type: typeof MARKET_STATISTICS_DELTA_OPERATION_TYPE.removeItems;
      level: number;
      count: number;
    }
  | {
      type: typeof MARKET_STATISTICS_DELTA_OPERATION_TYPE.changeItems;
      chunks: ChangedIndicatorChunk[];
    };

export class MarketStatisticsStorageService {
  public constructor(
    private readonly marketName: string,
    private readonly indicatorRegistry =
      globalStateService.getIndicatorRegistry(),
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

  private readonly indicatorChunksByLevel =
    MARKET_STATISTICS_LEVEL_CONFIGS.map(
      () => new Map<string, Uint8Array[]>(),
    );

  private deltaOperations: DeltaOperation[] = [];

  applyIndicatorResults(
    results: readonly IndicatorResults[],
  ): AppliedIndicatorResults {
    const lastPosition = this.getLatestPointPosition();

    if (!lastPosition) {
      throw new Error(
        `Cannot apply indicator results: market "${this.marketName}" ` +
        'storage is empty',
      );
    }

    const lastIndicators: MarketIndicatorValues = Object.fromEntries(
      results.map((result) => [
        result.indicatorName,
        result.lastResult,
      ]),
    );

    this.addIndicators(
      lastPosition.item.receivedAt,
      lastIndicators,
      lastPosition.level,
    );

    const changedChunks = results.flatMap((result) =>
      this.splitIndicatorResultsByLevels(result),
    );

    for (const chunk of changedChunks) {
      this.applyIndicatorChunk(chunk);
    }

    if (changedChunks.length > 0) {
      this.deltaOperations.push({
        type: MARKET_STATISTICS_DELTA_OPERATION_TYPE.changeItems,
        chunks: changedChunks,
      });
    }

    const finalLastIndicators = this.readIndicatorsAtPosition(
      lastPosition.level,
      lastPosition.chunkIndex,
      lastPosition.itemIndex,
    );

    this.updateAddItemDeltaIndicators(
      lastPosition.level,
      lastPosition.item.receivedAt,
      finalLastIndicators,
    );

    return {
      changedChunks,
      persistenceChanges:
        this.buildIndicatorPersistenceChanges(changedChunks),
    };
  }

  applyIndicatorChunks(
    chunks: readonly IndicatorValuesChunk[],
  ): void {
    for (const chunk of chunks) {
      this.applyIndicatorChunk(chunk);
    }
  }

  addItem(
    level: number,
    item: MarketCandle,
    deltaRecordMode: MarketStatisticsDeltaRecordMode = 'should record delta',
  ): number {
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

    writeMarketCandleToFloat64Array(
      chunk.data,
      chunk.end,
      level,
      item,
    );

    this.writeEmptyIndicatorsAtPosition(
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
      this.deltaOperations.push({
        type: MARKET_STATISTICS_DELTA_OPERATION_TYPE.addItem,
        level,
        item,
        indicators: null,
      });
    }

    return (
      this.levels
        .slice(level)
        .reduce(
          (sum, levelStorage) => sum + levelStorage.size,
          0,
        ) - 1
    );
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
        `Cannot remove ${count} items from level ${level}: level size is ${levelStorage.size}`,
      );
    }

    let remaining = count;

    while (remaining > 0) {
      const chunk = levelStorage.chunks[0];

      if (!chunk) {
        throw new Error(
          `Cannot remove ${count} items from level ${level}: storage is empty`,
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
      let deltaCount = count;

      while (deltaCount > 0) {
        const operationCount = Math.min(deltaCount, 255);

        this.deltaOperations.push({
          type: MARKET_STATISTICS_DELTA_OPERATION_TYPE.removeItems,
          level,
          count: operationCount,
        });

        deltaCount -= operationCount;
      }
    }
  }

  commitDelta(): ArrayBuffer | null {
    if (this.deltaOperations.length === 0) {
      return null;
    }

    const byteLength = this.deltaOperations.reduce(
      (sum, operation) =>
        sum + this.getDeltaOperationByteLength(operation),
      0,
    );

    const buffer = new ArrayBuffer(byteLength);
    const view = new DataView(buffer);

    let offset = 0;

    for (const operation of this.deltaOperations) {
      if (
        operation.type ===
        MARKET_STATISTICS_DELTA_OPERATION_TYPE.changeItems
      ) {
        for (const chunk of operation.chunks) {
          offset = this.writeChangedIndicatorChunk(
            view,
            offset,
            chunk,
          );
        }

        continue;
      }

      const opTypeAndLevel =
        (operation.type << 4) | operation.level;

      view.setUint8(offset, opTypeAndLevel);
      offset += 1;

      if (
        operation.type ===
        MARKET_STATISTICS_DELTA_OPERATION_TYPE.addItem
      ) {
        offset = this.writeDeltaItem(
          view,
          offset,
          operation.level,
          operation.item,
          operation.indicators,
        );

        continue;
      }

      view.setUint8(offset, operation.count);
      offset += 1;
    }

    this.deltaOperations = [];

    return buffer;
  }

  applyDelta(delta: ArrayBuffer): void {
    const view = new DataView(delta);

    let offset = 0;

    while (offset < delta.byteLength) {
      const opTypeAndLevel = view.getUint8(offset);
      offset += 1;

      const operationType = opTypeAndLevel >> 4;
      const level = opTypeAndLevel & 0x0f;

      if (operationType === MARKET_STATISTICS_DELTA_OPERATION_TYPE.addItem) {
        const result = this.readDeltaItem(view, offset, level);

        this.addItem(
          level,
          result.item,
          'suppress record delta',
        );

        this.addIndicators(
          result.item.receivedAt,
          result.indicators,
          level,
        );

        offset = result.nextOffset;
        continue;
      }

      if (operationType === MARKET_STATISTICS_DELTA_OPERATION_TYPE.removeItems) {
        const count = view.getUint8(offset);
        offset += 1;

        this.removeNItems(
          level,
          count,
          'suppress record delta',
        );

        continue;
      }

      if (
        operationType ===
        MARKET_STATISTICS_DELTA_OPERATION_TYPE.changeItems
      ) {
        const result = this.readChangedIndicatorChunk(
          view,
          offset,
          level,
        );

        this.applyIndicatorChunks([
          result.chunk,
        ]);

        offset = result.nextOffset;
        continue;
      }

      throw new Error(`Unknown market statistics delta operation: ${operationType}`);
    }
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
            readMarketCandleFromFloat64Array(
              chunk.data,
              itemIndex,
              level,
            ),
          );

          indicators.push(
            this.readIndicatorsAtPosition(
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

    this.deltaOperations = [];
  }

  getLevels(): readonly MarketStatisticsLevel[] {
    return this.levels;
  }

  getLevel(level: number): MarketStatisticsLevel | null {
    return this.levels[level] ?? null;
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

  getLastItem(level: number): MarketCandle | null {
    const levelStorage = this.levels[level];

    if (!levelStorage || levelStorage.size === 0) {
      return null;
    }

    const chunk = levelStorage.chunks.at(-1);

    if (!chunk || chunk.size === 0) {
      return null;
    }

    return readMarketCandleFromFloat64Array(
      chunk.data,
      chunk.end - 1,
      level,
    );
  }

  readItemsBefore(
    level: number,
    cutoff: number,
    direction: MarketDataProjectionDirection = 'ascending',
  ): MarketCandle[] {
    const levelStorage = this.levels[level];
    const config = MARKET_STATISTICS_LEVEL_CONFIGS[level];

    if (!levelStorage || !config || levelStorage.size === 0) {
      return [];
    }

    const result: MarketCandle[] = [];

    for (const chunk of levelStorage.chunks) {
      if (chunk.size === 0) {
        continue;
      }

      for (let itemIndex = chunk.start; itemIndex < chunk.end; itemIndex += 1) {
        const item = readMarketCandleFromFloat64Array(
          chunk.data,
          itemIndex,
          level,
        );

        if (item.endedAt >= cutoff) {
          return direction === 'ascending' ? result : result.reverse();
        }

        result.push(item);
      }
    }

    return direction === 'ascending' ? result : result.reverse();
  }

  readItemsAfter(
    level: number,
    cutoff: number,
    direction: MarketDataProjectionDirection = 'ascending',
  ): MarketCandle[] {
    const levelStorage = this.levels[level];
    const config = MARKET_STATISTICS_LEVEL_CONFIGS[level];

    if (!levelStorage || !config || levelStorage.size === 0) {
      return [];
    }

    const result: MarketCandle[] = [];

    for (let chunkIndex = levelStorage.chunks.length - 1; chunkIndex >= 0; chunkIndex -= 1) {
      const chunk = levelStorage.chunks[chunkIndex];

      if (chunk.size === 0) {
        continue;
      }

      for (let itemIndex = chunk.end - 1; itemIndex >= chunk.start; itemIndex -= 1) {
        const item = readMarketCandleFromFloat64Array(
          chunk.data,
          itemIndex,
          level,
        );

        if (item.startedAt < cutoff) {
          return direction === 'ascending' ? result.reverse() : result;
        }

        result.push(item);
      }
    }

    return direction === 'ascending' ? result.reverse() : result;
  }

  public createIntervalProjection(
    interval: number,
    now: number = Date.now(),
  ): MarketDataProjectionSnapshot {
    const view = this.getMarketDataView();
    const { candles, indicators } = view.ascending;

    const cutoff = now - interval;

    let startIndex = 0;

    while (startIndex < candles.length) {
      const candle = candles[startIndex];

      if (candle && candle.receivedAt >= cutoff) {
        break;
      }

      startIndex += 1;
    }

    const projectedCandles: MarketCandle[] = [];
    const projectedIndicators: MarketIndicatorValues[] = [];

    for (
      let index = startIndex;
      index < candles.length;
      index += 1
    ) {
      const candle = candles[index];
      const indicatorValues = indicators[index];

      if (!candle || !indicatorValues) {
        throw new Error(
          `Cannot create market data projection for "${this.marketName}": ` +
          `missing data at ascending index ${index}`,
        );
      }

      projectedCandles.push(candle);
      projectedIndicators.push(indicatorValues);
    }

    return {
      candles: projectedCandles,
      indicators: projectedIndicators,
    };
  }

  getMarketDataView(): MarketDataView {
    const receivedAt =
      this.getLatestPointPosition()?.item.receivedAt;

    if (receivedAt === undefined) {
      throw new Error(
        `Cannot get market data view: market "${this.marketName}" storage is empty`,
      );
    }

    return {
      receivedAt,
      marketName: this.marketName,
      ascending: this.createDataViewProxy('ascending'),
      descending: this.createDataViewProxy('descending'),
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

  private addIndicators(
    receivedAt: number,
    indicators: MarketIndicatorValues,
    level = 0,
  ): boolean {
    const position = this.getLastPointPosition(level);

    if (!position) {
      console.error('Cannot add market indicators: level is empty', {
        marketName: this.marketName,
        level,
        receivedAt,
        indicators,
      });

      return false;
    }

    const isReceivedAtMatching =
      position.item.receivedAt === receivedAt;

    const indicatorsToWrite = isReceivedAtMatching
      ? this.normalizeIndicatorValues(indicators)
      : this.createEmptyIndicators();

    if (!isReceivedAtMatching) {
      console.error('Cannot add market indicators: receivedAt mismatch', {
        marketName: this.marketName,
        level,
        expectedReceivedAt: position.item.receivedAt,
        actualReceivedAt: receivedAt,
        indicators,
      });
    }

    this.writeIndicatorsAtPosition(
      position.level,
      position.chunkIndex,
      position.itemIndex,
      indicatorsToWrite,
    );

    this.updateAddItemDeltaIndicators(
      position.level,
      position.item.receivedAt,
      indicatorsToWrite,
    );

    return isReceivedAtMatching;
  }

  private updateAddItemDeltaIndicators(
    level: number,
    receivedAt: number,
    indicators: MarketIndicatorValues,
  ): void {
    for (
      let index = this.deltaOperations.length - 1;
      index >= 0;
      index -= 1
    ) {
      const operation = this.deltaOperations[index];

      if (
        operation.type === MARKET_STATISTICS_DELTA_OPERATION_TYPE.addItem &&
        operation.level === level &&
        operation.item.receivedAt === receivedAt
      ) {
        operation.indicators = indicators;
        return;
      }
    }
  }

  private applyIndicatorChunk(
    chunk: IndicatorValuesChunk,
  ): void {
    const levelStorage = this.levels[chunk.level];

    if (!levelStorage) {
      throw new Error(
        `Unknown market statistics level: ${chunk.level}`,
      );
    }

    if (
      !Number.isInteger(chunk.offset) ||
      chunk.offset < 0 ||
      chunk.offset + chunk.values.length > levelStorage.size
    ) {
      throw new Error(
        `Changed indicator chunk is out of level bounds: ` +
        `level ${chunk.level}, offset ${chunk.offset}, ` +
        `length ${chunk.values.length}, level size ${levelStorage.size}`,
      );
    }

    for (const [offset, value] of chunk.values.entries()) {
      this.writeIndicatorAtLevelOffset(
        chunk.level,
        chunk.offset + offset,
        chunk.indicatorName,
        value,
      );
    }
  }

  private writeIndicatorAtLevelOffset(
    level: number,
    levelOffset: number,
    indicatorName: string,
    value: number | null,
  ): void {
    const position = this.resolveLevelOffset(level, levelOffset);

    this.writeIndicatorAtPosition(
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
        `Market statistics level offset out of range: level ${level}, offset ${levelOffset}`,
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
      `Cannot resolve market statistics level offset: level ${level}, offset ${levelOffset}`,
    );
  }

  private writeIndicatorAtPosition(
    level: number,
    chunkIndex: number,
    itemIndex: number,
    indicatorName: string,
    value: number | null,
  ): void {
    const indicatorConfig = this.indicatorRegistry.find(
      (item) => item.name === indicatorName,
    );

    if (!indicatorConfig) {
      console.error('Cannot write unknown indicator', {
        marketName: this.marketName,
        indicatorName,
      });

      return;
    }

    const chunk =
      this.indicatorChunksByLevel[level].get(indicatorName)?.[chunkIndex];

    if (!chunk) {
      throw new Error(
        `Indicator chunk "${indicatorName}" not found for level ${level}, chunk ${chunkIndex}`,
      );
    }

    const byteOffset =
      itemIndex * getIndicatorValueByteLength(indicatorConfig.codecIndex);

    const view = new DataView(
      chunk.buffer,
      chunk.byteOffset,
      chunk.byteLength,
    );

    writeIndicatorValue(
      view,
      byteOffset,
      indicatorConfig.codecIndex,
      value,
    );
  }

  private getCandleByPointIndex(index: number): MarketCandle | null {
    return this.readCandleByResolvedPoint(
      this.resolvePointIndex(index),
    );
  }

  private readCandleByResolvedPoint(
    resolved: {
      level: number;
      chunk: MarketStatisticsChunk;
      itemIndex: number;
    },
  ): MarketCandle {
    return readMarketCandleFromFloat64Array(
      resolved.chunk.data,
      resolved.itemIndex,
      resolved.level,
    );
  }

  private getLastPointPosition(
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
      item: readMarketCandleFromFloat64Array(
        chunk.data,
        itemIndex,
        level,
      ),
    };
  }

  private splitIndicatorResultsByLevels(
    result: IndicatorResults,
  ): ChangedIndicatorChunk[] {
    const chunks: ChangedIndicatorChunk[] = [];

    for (const recalculatedItem of result.recalculatedValues) {
      let currentChunk: ChangedIndicatorChunk | null = null;
      let previousLevelOffset: number | null = null;

      for (const [offset, value] of recalculatedItem.values.entries()) {
        const pointIndex =
          recalculatedItem.startIndexAsc + offset;

        const resolved = this.resolvePointIndex(pointIndex);
        const candle = this.readCandleByResolvedPoint(resolved);

        if (
          currentChunk === null ||
          currentChunk.level !== resolved.level ||
          previousLevelOffset === null ||
          resolved.levelOffset !== previousLevelOffset + 1
        ) {
          currentChunk = {
            indicatorName: result.indicatorName,
            level: resolved.level,
            offset: resolved.levelOffset,
            startReceivedAt: candle.receivedAt,
            endReceivedAt: candle.receivedAt,
            values: [],
          };

          chunks.push(currentChunk);
        }

        currentChunk.values.push(value);
        currentChunk.endReceivedAt = candle.receivedAt;

        previousLevelOffset = resolved.levelOffset;
      }
    }

    return chunks;
  }

  private getIndicatorsByPointIndex(index: number): MarketIndicatorValues | null {
    const resolved = this.resolvePointIndex(index);

    return this.readIndicatorsAtPosition(
      resolved.level,
      resolved.chunkIndex,
      resolved.itemIndex,
    );
  }

  private createDataViewProxy(
    direction: MarketDataProjectionDirection,
  ): MarketDataProjection {
    return {
      candles: this.createDataArrayProxy(
        direction,
        (index) => this.getCandleByPointIndex(index),
      ),
      indicators: this.createDataArrayProxy(
        direction,
        (index) => this.getIndicatorsByPointIndex(index),
      ),
    };
  }

  private createDataArrayProxy<TItem>(
    direction: MarketDataProjectionDirection,
    getItem: (index: number) => TItem | null,
  ): MarketDataArray<TItem> {
    const storage = this;
    const target = {
      get length(): number {
        return storage.size();
      },
    };

    const normalizeIndex = (index: number): number | null => {
      const length = storage.size();

      if (!Number.isInteger(index) || index < 0 || index >= length) {
        return null;
      }

      if (direction === 'ascending') {
        return index;
      }

      return length - 1 - index;
    };

    return new Proxy(target, {
      get(proxyTarget, property, receiver) {
        if (typeof property === 'string' && isArrayIndexProperty(property)) {
          const normalizedIndex = normalizeIndex(Number(property));

          if (normalizedIndex === null) {
            return undefined;
          }

          return getItem(normalizedIndex) ?? undefined;
        }

        return Reflect.get(proxyTarget, property, receiver);
      },

      set() {
        throw new Error('Market data view is read-only');
      },

      deleteProperty() {
        throw new Error('Market data view is read-only');
      },
    }) as MarketDataArray<TItem>;
  }

  private resolvePointIndex(index: number): {
    level: number;
    levelOffset: number;
    chunk: MarketStatisticsChunk;
    chunkIndex: number;
    itemIndex: number;
  } {
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

  private createLevel(): MarketStatisticsLevel {
    return {
      chunks: [],
      size: 0,
      startedAt: null,
      endedAt: null,
    };
  }

  private createChunk(level: number): MarketStatisticsChunk {
    const fieldsPerItem = getMarketStatisticsFieldsPerItem(level);
    const chunkCapacity = MARKET_STATISTICS_LEVEL_CONFIGS[level].chunkCapacity;

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
      throw new Error(`Unknown market statistics level: ${level}`);
    }

    const chunksByIndicator = this.indicatorChunksByLevel[level];

    for (const indicatorConfig of this.indicatorRegistry) {
      let indicatorChunks = chunksByIndicator.get(indicatorConfig.name);

      if (!indicatorChunks) {
        indicatorChunks = [];
        chunksByIndicator.set(indicatorConfig.name, indicatorChunks);
      }

      indicatorChunks.push(
        this.createIndicatorChunk(
          config.chunkCapacity,
          indicatorConfig.codecIndex,
        ),
      );
    }
  }

  private removeFirstIndicatorChunk(level: number): void {
    const chunksByIndicator = this.indicatorChunksByLevel[level];

    for (const chunks of chunksByIndicator.values()) {
      chunks.shift();
    }
  }

  private syncIndicatorChunksWithCandleChunks(level: number): void {
    const levelStorage = this.levels[level];
    const chunksByIndicator = this.indicatorChunksByLevel[level];

    for (const indicatorConfig of this.indicatorRegistry) {
      let chunks = chunksByIndicator.get(indicatorConfig.name);

      if (!chunks) {
        chunks = [];
        chunksByIndicator.set(indicatorConfig.name, chunks);
      }

      while (chunks.length < levelStorage.chunks.length) {
        chunks.push(
          this.createIndicatorChunk(
            MARKET_STATISTICS_LEVEL_CONFIGS[level].chunkCapacity,
            indicatorConfig.codecIndex,
          ),
        );
      }

      if (chunks.length > levelStorage.chunks.length) {
        chunks.splice(levelStorage.chunks.length);
      }
    }

    for (const indicatorName of [...chunksByIndicator.keys()]) {
      if (!this.indicatorRegistry.some((item) => item.name === indicatorName)) {
        chunksByIndicator.delete(indicatorName);
      }
    }
  }

  private createIndicatorChunk(
    chunkCapacity: number,
    codecIndex: number,
  ): Uint8Array {
    const byteLength =
      chunkCapacity * getIndicatorValueByteLength(codecIndex);

    const data = new Uint8Array(byteLength);
    const view = new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );

    let offset = 0;

    for (let index = 0; index < chunkCapacity; index += 1) {
      offset = writeIndicatorValue(
        view,
        offset,
        codecIndex,
        null,
      );
    }

    return data;
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
        `Market statistics level ${level} has size ${levelStorage.size} but has no chunks`,
      );
    }

    const first = readMarketCandleFromFloat64Array(
      firstChunk.data,
      firstChunk.start,
      level,
    );

    const last = readMarketCandleFromFloat64Array(
      lastChunk.data,
      lastChunk.end - 1,
      level,
    );

    levelStorage.startedAt = first.startedAt;
    levelStorage.endedAt = last.endedAt;
  }

  private readIndicatorsAtPosition(
    level: number,
    chunkIndex: number,
    itemIndex: number,
  ): MarketIndicatorValues {
    const result: MarketIndicatorValues = {};

    for (const indicatorConfig of this.indicatorRegistry) {
      result[indicatorConfig.name] =
        this.readIndicatorAtPosition(
          level,
          chunkIndex,
          itemIndex,
          indicatorConfig.name,
        );
    }

    return result;
  }

  private readIndicatorAtPosition(
    level: number,
    chunkIndex: number,
    itemIndex: number,
    name: string,
  ): number | null {
    const indicatorConfig = this.indicatorRegistry.find(
      (item) => item.name === name,
    );

    if (!indicatorConfig) {
      return null;
    }

    const indicatorChunks =
      this.indicatorChunksByLevel[level].get(name);

    const indicatorChunk = indicatorChunks?.[chunkIndex];

    if (!indicatorChunk) {
      return null;
    }

    const byteOffset =
      itemIndex * getIndicatorValueByteLength(indicatorConfig.codecIndex);

    const view = new DataView(
      indicatorChunk.buffer,
      indicatorChunk.byteOffset,
      indicatorChunk.byteLength,
    );

    return readIndicatorValue(
      view,
      byteOffset,
      indicatorConfig.codecIndex,
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

  private writeEmptyIndicatorsAtPosition(
    level: number,
    chunkIndex: number,
    itemIndex: number,
  ): void {
    this.writeIndicatorsAtPosition(
      level,
      chunkIndex,
      itemIndex,
      this.createEmptyIndicators(),
    );
  }

  private writeIndicatorsAtPosition(
    level: number,
    chunkIndex: number,
    itemIndex: number,
    indicators: MarketIndicatorValues,
  ): void {
    const normalizedIndicators =
      this.normalizeIndicatorValues(indicators);

    const chunksByIndicator =
      this.indicatorChunksByLevel[level];

    for (const indicatorConfig of this.indicatorRegistry) {
      const chunks =
        chunksByIndicator.get(indicatorConfig.name);

      const chunk = chunks?.[chunkIndex];

      if (!chunk) {
        throw new Error(
          `Indicator chunk "${indicatorConfig.name}" not found ` +
          `for level ${level}, chunk ${chunkIndex}`,
        );
      }

      const byteOffset =
        itemIndex *
        getIndicatorValueByteLength(
          indicatorConfig.codecIndex,
        );

      const view = new DataView(
        chunk.buffer,
        chunk.byteOffset,
        chunk.byteLength,
      );

      writeIndicatorValue(
        view,
        byteOffset,
        indicatorConfig.codecIndex,
        normalizedIndicators[indicatorConfig.name],
      );
    }
  }

  private getLatestPointPosition(): {
    level: number;
    chunkIndex: number;
    itemIndex: number;
    item: MarketCandle;
  } | null {
    for (let level = 0; level < this.levels.length; level += 1) {
      const position = this.getLastPointPosition(level);

      if (position) {
        return position;
      }
    }

    return null;
  }

  private getDeltaOperationByteLength(
    operation: DeltaOperation,
  ): number {
    if (
      operation.type ===
      MARKET_STATISTICS_DELTA_OPERATION_TYPE.removeItems
    ) {
      return 2;
    }

    if (
      operation.type ===
      MARKET_STATISTICS_DELTA_OPERATION_TYPE.changeItems
    ) {
      return operation.chunks.reduce(
        (sum, chunk) =>
          sum + this.getChangedIndicatorChunkByteLength(chunk),
        0,
      );
    }

    return (
      1 +
      getMarketCandleByteLength(operation.level) +
      this.getIndicatorValuesByteLength()
    );
  }

  private getIndicatorValuesByteLength(): number {
    return this.indicatorRegistry.reduce(
      (sum, indicatorConfig) =>
        sum + getIndicatorValueByteLength(indicatorConfig.codecIndex),
      0,
    );
  }

  private writeDeltaItem(
    view: DataView,
    offset: number,
    level: number,
    item: MarketCandle,
    indicators: MarketIndicatorValues | null,
  ): number {
    offset = writeMarketCandleToDataView(
      view,
      offset,
      level,
      item,
    );

    return this.writeDeltaIndicators(
      view,
      offset,
      indicators,
    );
  }

  private readDeltaItem(
    view: DataView,
    offset: number,
    level: number,
  ): {
    item: MarketCandle;
    indicators: MarketIndicatorValues;
    nextOffset: number;
  } {
    const result = readMarketCandleFromDataView(view, offset, level);

    return {
      item: result.item,
      ...this.readDeltaIndicators(view, result.nextOffset),
    };
  }

  private writeDeltaIndicators(
    view: DataView,
    offset: number,
    indicators: MarketIndicatorValues | null,
  ): number {
    for (const indicatorConfig of this.indicatorRegistry) {
      offset = writeIndicatorValue(
        view,
        offset,
        indicatorConfig.codecIndex,
        indicators?.[indicatorConfig.name] ?? null,
      );
    }

    return offset;
  }

  private readDeltaIndicators(
    view: DataView,
    offset: number,
  ): {
    indicators: MarketIndicatorValues;
    nextOffset: number;
  } {
    const indicators: MarketIndicatorValues = {};

    for (const indicatorConfig of this.indicatorRegistry) {
      const result = readIndicatorValue(
        view,
        offset,
        indicatorConfig.codecIndex,
      );

      indicators[indicatorConfig.name] = result.value;
      offset = result.nextOffset;
    }

    return {
      indicators,
      nextOffset: offset,
    };
  }

  private getChangedIndicatorChunkByteLength(
    chunk: ChangedIndicatorChunk,
  ): number {
    const indicatorConfig = this.getIndicatorConfig(
      chunk.indicatorName,
    );

    return (
      1 +
      1 +
      2 +
      2 +
      chunk.values.length *
        getIndicatorValueByteLength(indicatorConfig.codecIndex)
    );
  }

  private writeChangedIndicatorChunk(
    view: DataView,
    offset: number,
    chunk: ChangedIndicatorChunk,
  ): number {
    if (chunk.level < 0 || chunk.level > 0x0f) {
      throw new Error(
        `Market statistics level cannot be packed: ${chunk.level}`,
      );
    }

    const indicatorIndex = this.indicatorRegistry.findIndex(
      (indicator) =>
        indicator.name === chunk.indicatorName,
    );

    if (indicatorIndex < 0) {
      throw new Error(
        `Unknown indicator "${chunk.indicatorName}"`,
      );
    }

    if (indicatorIndex > 0xff) {
      throw new Error(
        `Indicator registry index is too large: ${indicatorIndex}`,
      );
    }

    if (
      !Number.isInteger(chunk.offset) ||
      chunk.offset < 0 ||
      chunk.offset > 0xffff
    ) {
      throw new Error(
        `Changed indicator chunk offset cannot be packed: ${chunk.offset}`,
      );
    }

    if (chunk.values.length > 0xffff) {
      throw new Error(
        `Changed indicator chunk is too large: ${chunk.values.length}`,
      );
    }

    const indicatorConfig =
      this.indicatorRegistry[indicatorIndex];

    const opTypeAndLevel =
      (
        MARKET_STATISTICS_DELTA_OPERATION_TYPE.changeItems << 4
      ) | chunk.level;

    view.setUint8(offset, opTypeAndLevel);
    offset += 1;

    view.setUint8(offset, indicatorIndex);
    offset += 1;

    view.setUint16(offset, chunk.offset, true);
    offset += 2;

    view.setUint16(offset, chunk.values.length, true);
    offset += 2;

    for (const value of chunk.values) {
      offset = writeIndicatorValue(
        view,
        offset,
        indicatorConfig.codecIndex,
        value,
      );
    }

    return offset;
  }

  private readChangedIndicatorChunk(
    view: DataView,
    offset: number,
    level: number,
  ): {
    chunk: IndicatorValuesChunk;
    nextOffset: number;
  } {
    const indicatorIndex = view.getUint8(offset);
    offset += 1;

    const indicatorConfig =
      this.indicatorRegistry[indicatorIndex];

    if (!indicatorConfig) {
      throw new Error(
        `Unknown indicator registry index: ${indicatorIndex}`,
      );
    }

    const levelOffset = view.getUint16(offset, true);
    offset += 2;

    const valuesLength = view.getUint16(offset, true);
    offset += 2;

    const values: (number | null)[] = [];

    for (let index = 0; index < valuesLength; index += 1) {
      const result = readIndicatorValue(
        view,
        offset,
        indicatorConfig.codecIndex,
      );

      values.push(result.value);
      offset = result.nextOffset;
    }

    return {
      chunk: {
        indicatorName: indicatorConfig.name,
        level,
        offset: levelOffset,
        values,
      },
      nextOffset: offset,
    };
  }

  private getIndicatorConfig(
    indicatorName: string,
  ) {
    const config = this.indicatorRegistry.find(
      (indicator) => indicator.name === indicatorName,
    );

    if (!config) {
      throw new Error(
        `Unknown indicator "${indicatorName}"`,
      );
    }

    return config;
  }

  private buildIndicatorPersistenceChanges(
    chunks: readonly ChangedIndicatorChunk[],
  ): CandleIndicatorsChange[] {
    interface PendingChange {
      startedAt: number;
      endedAt: number;
      indicators: MarketIndicatorValues;
    }

    const changesByLevel =
      new Map<number, Map<string, PendingChange>>();

    for (const chunk of chunks) {
      let changesByCandle =
        changesByLevel.get(chunk.level);

      if (!changesByCandle) {
        changesByCandle =
          new Map<string, PendingChange>();

        changesByLevel.set(
          chunk.level,
          changesByCandle,
        );
      }

      for (
        let valueOffset = 0;
        valueOffset < chunk.values.length;
        valueOffset += 1
      ) {
        const levelOffset =
          chunk.offset + valueOffset;

        const position = this.resolveLevelOffset(
          chunk.level,
          levelOffset,
        );

        const levelStorage =
          this.levels[chunk.level];

        const candleChunk =
          levelStorage?.chunks[position.chunkIndex];

        if (!candleChunk) {
          throw new Error(
            `Cannot build indicator persistence change: ` +
            `candle chunk not found for level ${chunk.level}, ` +
            `chunk ${position.chunkIndex}`,
          );
        }

        const candle =
          readMarketCandleFromFloat64Array(
            candleChunk.data,
            position.itemIndex,
            chunk.level,
          );

        const candleKey =
          `${candle.startedAt}:${candle.endedAt}`;

        let pendingChange =
          changesByCandle.get(candleKey);

        if (!pendingChange) {
          pendingChange = {
            startedAt: candle.startedAt,
            endedAt: candle.endedAt,
            indicators: {},
          };

          changesByCandle.set(
            candleKey,
            pendingChange,
          );
        }

        pendingChange.indicators[
          chunk.indicatorName
        ] = chunk.values[valueOffset];
      }
    }

    const result: CandleIndicatorsChange[] = [];

    for (
      const [level, changesByCandle]
      of changesByLevel
    ) {
      for (
        const change
        of changesByCandle.values()
      ) {
        result.push({
          level,
          startedAt: change.startedAt,
          endedAt: change.endedAt,
          indicators: change.indicators,
        });
      }
    }

    return result;
  }
}

function isArrayIndexProperty(property: string): boolean {
  if (property === '') {
    return false;
  }

  const index = Number(property);

  return (
    Number.isInteger(index) &&
    index >= 0 &&
    String(index) === property
  );
}
