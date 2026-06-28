import {
  MARKET_STATISTICS_DELTA_OPERATION_TYPE,
  MARKET_STATISTICS_LEVEL_CONFIGS,
} from '../constants/market-statistics-storage.js';

import type {
  MarketCandle,
  MarketSnapshot,
  MarketStatisticsChunk,
  MarketStatisticsDeltaRecordMode,
  MarketStatisticsItem,
  MarketStatisticsItems,
  MarketStatisticsItemsDirection,
  MarketStatisticsLevel,
} from '../types/market-statistics-storage.js';

import {
  getMarketStatisticsFieldsPerItem,
  getMarketStatisticsItemByteLength,
  readMarketStatisticsItemFromDataView,
  readMarketStatisticsItemFromFloat64Array,
  writeMarketStatisticsItemToDataView,
  writeMarketStatisticsItemToFloat64Array,
} from '../utilities/market-statistics-codec.js';

type DeltaOperation =
  | {
      type: typeof MARKET_STATISTICS_DELTA_OPERATION_TYPE.addItem;
      level: number;
      item: MarketStatisticsItem;
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
    item: MarketStatisticsItem,
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

    if (config.sourceType === 'snapshot') {
      writeMarketStatisticsItemToFloat64Array(
        chunk.data,
        chunk.end,
        level,
        item,
      );

      levelStorage.startedAt ??= item.receivedAt;
      levelStorage.endedAt = item.receivedAt;
    } else {
      const candle = item as MarketCandle;

      writeMarketStatisticsItemToFloat64Array(
        chunk.data,
        chunk.end,
        level,
        candle,
      );

      levelStorage.startedAt ??= candle.startedAt;
      levelStorage.endedAt = candle.endedAt;
    }

    chunk.end++;

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

    let remaining = count;

    while (remaining > 0) {
      const chunk = levelStorage.chunks[0];

      if (!chunk) {
        throw new Error(
          `Cannot remove ${count} items from level ${level}: storage is empty`,
        );
      }

      const available = chunk.end - chunk.start;
      const removed = Math.min(available, remaining);

      chunk.start += removed;
      remaining -= removed;

      if (chunk.start === chunk.end) {
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

  public getAllItemsByLevel(): MarketStatisticsItem[][] {
    return this.levels.map((levelStorage, level) => {
      const config = MARKET_STATISTICS_LEVEL_CONFIGS[level];
      const items: MarketStatisticsItem[] = [];

      for (const chunk of levelStorage.chunks) {
        for (let itemIndex = chunk.start; itemIndex < chunk.end; itemIndex++) {
          items.push(
            readMarketStatisticsItemFromFloat64Array(
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

  getStartedAt(level: number): number | null {
    return this.levels[level]?.startedAt ?? null;
  }

  getEndedAt(level: number): number | null {
    return this.levels[level]?.endedAt ?? null;
  }

  getLastItem(level: number): MarketStatisticsItem | null {
    const levelStorage = this.levels[level];
    const config = MARKET_STATISTICS_LEVEL_CONFIGS[level];

    if (!levelStorage || !config) {
      return null;
    }

    const chunk = levelStorage.chunks.at(-1);

    if (!chunk || chunk.start === chunk.end) {
      return null;
    }

    const itemIndex = chunk.end - 1;

    return readMarketStatisticsItemFromFloat64Array(
      chunk.data,
      itemIndex,
      level,
    );
  }

  readItemsBefore(
    level: number,
    cutoff: number,
  ): MarketStatisticsItem[] {
    const levelStorage = this.levels[level];
    const config = MARKET_STATISTICS_LEVEL_CONFIGS[level];

    if (!levelStorage || !config) {
      return [];
    }

    const result: MarketStatisticsItem[] = [];

    for (const chunk of levelStorage.chunks) {
      for (let itemIndex = chunk.start; itemIndex < chunk.end; itemIndex++) {
        const item = readMarketStatisticsItemFromFloat64Array(
          chunk.data,
          itemIndex,
          level,
        );

        const itemEndedAt = config.sourceType === 'snapshot'
          ? (item as MarketSnapshot).receivedAt
          : (item as MarketCandle).endedAt;

        if (itemEndedAt >= cutoff) {
          return result;
        }

        result.push(item);
      }
    }

    return result;
  }

  public createItems(
    direction: MarketStatisticsItemsDirection = 'direct',
  ): MarketStatisticsItems {
    return new MarketStatisticsItemsView(
      this.marketName,
      this,
      direction,
    );
  }

  public getPointSeriesLength(): number {
    return this.levels.reduce(
      (sum, level) => sum + this.getLevelItemsCount(level),
      0,
    );
  }

  public getSnapshotByPointIndex(index: number): MarketSnapshot {
    const resolved = this.resolvePointIndex(index);
    const config = MARKET_STATISTICS_LEVEL_CONFIGS[resolved.level];

    return readMarketStatisticsItemFromFloat64Array(
      resolved.chunk.data,
      resolved.itemIndex,
      resolved.level,
    ) as MarketSnapshot;
  }

  public getCandleByPointIndex(index: number): MarketCandle | null {
    const resolved = this.resolvePointIndex(index);
    const config = MARKET_STATISTICS_LEVEL_CONFIGS[resolved.level];

    if (config.sourceType !== 'candle') {
      return null;
    }

    return readMarketStatisticsItemFromFloat64Array(
      resolved.chunk.data,
      resolved.itemIndex,
      resolved.level,
    ) as MarketCandle;
  }

  public size(level?: number): number {
    if (typeof level === 'number') {
      return this.getLevelItemsCount(this.levels[level]);
    }

    return this.levels.reduce(
      (sum, level) => sum + this.getLevelItemsCount(level),
      0,
    );
  }

  private getLevelItemsCount(level: MarketStatisticsLevel): number {
    return level.chunks.reduce(
      (sum, chunk) => sum + chunk.end - chunk.start,
      0,
    );
  }

  private resolvePointIndex(index: number): {
    level: number;
    chunk: MarketStatisticsChunk;
    itemIndex: number;
  } {
    let rest = index;

    for (let level = this.levels.length - 1; level >= 0; level--) {
      const levelStorage = this.levels[level];

      for (const chunk of levelStorage.chunks) {
        const count = chunk.end - chunk.start;

        if (rest < count) {
          return {
            level,
            chunk,
            itemIndex: chunk.start + rest,
          };
        }

        rest -= count;
      }
    }

    throw new Error(`Market statistics item index out of range: ${index}`);
  }

  private createLevel(): MarketStatisticsLevel {
    return {
      chunks: [],
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
    };
  }

  private refreshLevelBounds(level: number): void {
    const config = MARKET_STATISTICS_LEVEL_CONFIGS[level];
    const levelStorage = this.levels[level];
    const firstChunk = levelStorage.chunks[0];
    const lastChunk = levelStorage.chunks.at(-1);

    if (!firstChunk || !lastChunk) {
      levelStorage.startedAt = null;
      levelStorage.endedAt = null;
      return;
    }

    if (config.sourceType === 'snapshot') {
      const first = readMarketStatisticsItemFromFloat64Array(
        firstChunk.data,
        firstChunk.start,
        level,
      ) as MarketSnapshot;
      const last = readMarketStatisticsItemFromFloat64Array(
        lastChunk.data,
        lastChunk.end - 1,
        level,
      ) as MarketSnapshot;

      levelStorage.startedAt = first.receivedAt;
      levelStorage.endedAt = last.receivedAt;
      return;
    }

    const first = readMarketStatisticsItemFromFloat64Array(
      firstChunk.data,
      firstChunk.start,
      level,
    ) as MarketCandle;
    const last = readMarketStatisticsItemFromFloat64Array(
      lastChunk.data,
      lastChunk.end - 1,
      level,
    ) as MarketCandle;

    levelStorage.startedAt = first.startedAt;
    levelStorage.endedAt = last.endedAt;
  }

  private getDeltaOperationByteLength(operation: DeltaOperation): number {
    if (operation.type === MARKET_STATISTICS_DELTA_OPERATION_TYPE.removeItems) {
      return 2;
    }

    return 1 + getMarketStatisticsItemByteLength(operation.level);
  }

  private writeDeltaItem(
    view: DataView,
    offset: number,
    level: number,
    item: MarketStatisticsItem,
  ): number {
    return writeMarketStatisticsItemToDataView(
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
    item: MarketStatisticsItem;
    nextOffset: number;
  } {
    return readMarketStatisticsItemFromDataView(view, offset, level);
  }

}

class MarketStatisticsItemsView implements MarketStatisticsItems {
  public constructor(
    public readonly marketName: string,
    private readonly storage: MarketStatisticsStorageService,
    private readonly direction: MarketStatisticsItemsDirection,
  ) {}

  public get length(): number {
    return this.storage.getPointSeriesLength();
  }

  public get(index: number): MarketSnapshot {
    return this.storage.getSnapshotByPointIndex(
      this.normalizeIndex(index),
    );
  }

  public candle(index: number): MarketCandle | null {
    return this.storage.getCandleByPointIndex(
      this.normalizeIndex(index),
    );
  }

  private normalizeIndex(index: number): number {
    if (index < 0 || index >= this.length) {
      throw new Error(`Market statistics item index out of range: ${index}`);
    }

    if (this.direction === 'direct') {
      return index;
    }

    return this.length - 1 - index;
  }
}
