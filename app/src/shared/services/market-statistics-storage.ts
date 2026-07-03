// app/src/shared/services/market-statistics-storage.ts
import {
  MARKET_STATISTICS_LEVEL_CONFIGS,
} from '../constants/market-statistics-config.js';

import {
  MARKET_STATISTICS_DELTA_OPERATION_TYPE,
} from '../constants/market-statistics-storage.js';

import type {
  MarketStatisticsChunk,
  MarketStatisticsDeltaRecordMode,
  MarketCandle,
  MarketCandles,
  MarketCandlesDirection,
  MarketStatisticsLevel,
} from '../types/market-statistics-storage.js';

import {
  getMarketStatisticsFieldsPerItem,
  getMarketCandleByteLength,
  readMarketCandleFromDataView,
  readMarketCandleFromFloat64Array,
  writeMarketCandleToDataView,
  writeMarketCandleToFloat64Array,
} from '../utilities/market-statistics-codec.js';

type DeltaOperation =
  | {
      type: typeof MARKET_STATISTICS_DELTA_OPERATION_TYPE.addItem;
      level: number;
      item: MarketCandle;
    }
  | {
      type: typeof MARKET_STATISTICS_DELTA_OPERATION_TYPE.removeItems;
      level: number;
      count: number;
    };

export class MarketStatisticsStorageService {
  public constructor(
    private readonly marketName: string,
  ) {}

  private readonly levels: MarketStatisticsLevel[] =
    MARKET_STATISTICS_LEVEL_CONFIGS.map(() => this.createLevel());

  private deltaOperations: DeltaOperation[] = [];

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
    }

    writeMarketCandleToFloat64Array(
      chunk.data,
      chunk.end,
      level,
      item,
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
      });
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
      (sum, operation) => sum + this.getDeltaOperationByteLength(operation),
      0,
    );

    const buffer = new ArrayBuffer(byteLength);
    const view = new DataView(buffer);

    let offset = 0;

    for (const operation of this.deltaOperations) {
      const opTypeAndLevel = (operation.type << 4) | operation.level;

      view.setUint8(offset, opTypeAndLevel);
      offset += 1;

      if (operation.type === MARKET_STATISTICS_DELTA_OPERATION_TYPE.addItem) {
        offset = this.writeDeltaItem(
          view,
          offset,
          operation.level,
          operation.item,
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

      throw new Error(`Unknown market statistics delta operation: ${operationType}`);
    }
  }

  public getAllItemsByLevel(): MarketCandle[][] {
    return this.levels.map((levelStorage, level) => {
      const items: MarketCandle[] = [];

      for (const chunk of levelStorage.chunks) {
        for (let itemIndex = chunk.start; itemIndex < chunk.end; itemIndex += 1) {
          items.push(
            readMarketCandleFromFloat64Array(
              chunk.data,
              itemIndex,
              level,
            ),
          );
        }
      }

      return items;
    });
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
    direction: MarketCandlesDirection = 'direct',
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
          return direction === 'direct' ? result : result.reverse();
        }

        result.push(item);
      }
    }

    return direction === 'direct' ? result : result.reverse();
  }

  readItemsAfter(
    level: number,
    cutoff: number,
    direction: MarketCandlesDirection = 'direct',
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
          return direction === 'direct' ? result.reverse() : result;
        }

        result.push(item);
      }
    }

    return direction === 'direct' ? result.reverse() : result;
  }

  public getViewsCreator(
    direction: MarketCandlesDirection = 'direct',
  ): MarketCandles {
    return this.createItemsProxy(direction);
  }

  public getCandleByPointIndex(index: number): MarketCandle | null {
    const resolved = this.resolvePointIndex(index);

    return readMarketCandleFromFloat64Array(
      resolved.chunk.data,
      resolved.itemIndex,
      resolved.level,
    );
  }

  public size(level?: number): number {
    if (typeof level === 'number') {
      return this.levels[level]?.size ?? 0;
    }

    return this.levels.reduce(
      (sum, levelStorage) => sum + levelStorage.size,
      0,
    );
  }

  private createItemsProxy(
    direction: MarketCandlesDirection,
  ): MarketCandles {
    const storage = this;
    const target = {
      marketName: this.marketName,

      get length(): number {
        return storage.size();
      },

      candle(index: number): MarketCandle | null {
        return storage.getCandleByPointIndex(
          normalizeIndex(index),
        );
      },
    };

    const normalizeIndex = (index: number): number => {
      const length = storage.size();

      if (!Number.isInteger(index) || index < 0 || index >= length) {
        throw new Error(`Market statistics item index out of range: ${index}`);
      }

      if (direction === 'direct') {
        return index;
      }

      return length - 1 - index;
    };

    return new Proxy(target, {
      get(proxyTarget, property, receiver) {
        if (typeof property === 'string' && isArrayIndexProperty(property)) {
          return storage.getCandleByPointIndex(
            normalizeIndex(Number(property)),
          );
        }

        return Reflect.get(proxyTarget, property, receiver);
      },

      set() {
        throw new Error('Market candles view is read-only');
      },

      deleteProperty() {
        throw new Error('Market candles view is read-only');
      },
    }) as MarketCandles;
  }

  private resolvePointIndex(index: number): {
    level: number;
    chunk: MarketStatisticsChunk;
    itemIndex: number;
  } {
    let rest = index;

    for (let level = this.levels.length - 1; level >= 0; level -= 1) {
      const levelStorage = this.levels[level];

      if (rest >= levelStorage.size) {
        rest -= levelStorage.size;
        continue;
      }

      for (const chunk of levelStorage.chunks) {
        if (rest < chunk.size) {
          return {
            level,
            chunk,
            itemIndex: chunk.start + rest,
          };
        }

        rest -= chunk.size;
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

  private getDeltaOperationByteLength(operation: DeltaOperation): number {
    if (operation.type === MARKET_STATISTICS_DELTA_OPERATION_TYPE.removeItems) {
      return 2;
    }

    return 1 + getMarketCandleByteLength(operation.level);
  }

  private writeDeltaItem(
    view: DataView,
    offset: number,
    level: number,
    item: MarketCandle,
  ): number {
    return writeMarketCandleToDataView(
      view,
      offset,
      level,
      item,
    );
  }

  private readDeltaItem(
    view: DataView,
    offset: number,
    level: number,
  ): {
    item: MarketCandle;
    nextOffset: number;
  } {
    return readMarketCandleFromDataView(view, offset, level);
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
