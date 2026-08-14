// app/src/shared/utilities/market-statistics-delta-codec.ts
import {
  MARKET_STATISTICS_DELTA_OPERATION_TYPE,
} from '../constants/market-statistics-storage.js';
import type { MarketCandle } from '../types/market-statistics-storage.js';
import {
  getMarketCandleByteLength,
  readMarketCandleFromDataView,
  writeMarketCandleToDataView,
} from './market-statistics-codec.js';

export type MarketStatisticsDeltaOperation =
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

const OPERATION_HEADER_BYTE_LENGTH = 1;
const REMOVE_ITEMS_COUNT_BYTE_LENGTH = 1;

export const encodeMarketStatisticsDelta = (
  operations: readonly MarketStatisticsDeltaOperation[],
): ArrayBuffer => {
  const byteLength = operations.reduce(
    (sum, operation) => sum + getDeltaOperationByteLength(operation),
    0,
  );

  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);

  let offset = 0;

  for (const operation of operations) {
    validateLevel(operation.level);

    const opTypeAndLevel = (operation.type << 4) | operation.level;

    view.setUint8(offset, opTypeAndLevel);
    offset += OPERATION_HEADER_BYTE_LENGTH;

    if (
      operation.type === MARKET_STATISTICS_DELTA_OPERATION_TYPE.addItem
    ) {
      offset = writeMarketCandleToDataView(view, offset, operation.item);
      continue;
    }

    view.setUint8(offset, operation.count);
    offset += REMOVE_ITEMS_COUNT_BYTE_LENGTH;
  }

  if (offset !== byteLength) {
    throw new Error(
      `Market statistics delta byte length mismatch: ` +
      `expected ${byteLength}, written ${offset}`,
    );
  }

  return buffer;
};

export const decodeMarketStatisticsDelta = (
  delta: Uint8Array,
): MarketStatisticsDeltaOperation[] => {
  const operations: MarketStatisticsDeltaOperation[] = [];

  const view = new DataView(
    delta.buffer,
    delta.byteOffset,
    delta.byteLength,
  );

  let offset = 0;

  while (offset < delta.byteLength) {
    ensureRemainingBytes(view, offset, OPERATION_HEADER_BYTE_LENGTH);

    const opTypeAndLevel = view.getUint8(offset);
    offset += OPERATION_HEADER_BYTE_LENGTH;

    const operationType = opTypeAndLevel >> 4;
    const level = opTypeAndLevel & 0x0f;

    if (
      operationType === MARKET_STATISTICS_DELTA_OPERATION_TYPE.addItem
    ) {
      ensureRemainingBytes(view, offset, getMarketCandleByteLength());

      const result = readMarketCandleFromDataView(view, offset);

      operations.push({
        type: MARKET_STATISTICS_DELTA_OPERATION_TYPE.addItem,
        level,
        item: result.item,
      });

      offset = result.nextOffset;
      continue;
    }

    if (
      operationType === MARKET_STATISTICS_DELTA_OPERATION_TYPE.removeItems
    ) {
      ensureRemainingBytes(view, offset, REMOVE_ITEMS_COUNT_BYTE_LENGTH);

      const count = view.getUint8(offset);
      offset += REMOVE_ITEMS_COUNT_BYTE_LENGTH;

      if (count === 0) {
        throw new Error(
          `Invalid market statistics delta removeItems count: ${count}`,
        );
      }

      operations.push({
        type: MARKET_STATISTICS_DELTA_OPERATION_TYPE.removeItems,
        level,
        count,
      });

      continue;
    }

    throw new Error(
      `Unknown market statistics delta operation: ${operationType}`,
    );
  }

  return operations;
};

const getDeltaOperationByteLength = (
  operation: MarketStatisticsDeltaOperation,
): number => {
  if (
    operation.type === MARKET_STATISTICS_DELTA_OPERATION_TYPE.addItem
  ) {
    return OPERATION_HEADER_BYTE_LENGTH + getMarketCandleByteLength();
  }

  return OPERATION_HEADER_BYTE_LENGTH + REMOVE_ITEMS_COUNT_BYTE_LENGTH;
};

const validateLevel = (level: number): void => {
  if (!Number.isInteger(level) || level < 0 || level > 0x0f) {
    throw new Error(`Market statistics level cannot be packed: ${level}`);
  }
};

const ensureRemainingBytes = (
  view: DataView,
  offset: number,
  requiredByteLength: number,
): void => {
  const remainingByteLength = view.byteLength - offset;

  if (remainingByteLength < requiredByteLength) {
    throw new Error(
      `Unexpected end of market statistics delta: ` +
      `${requiredByteLength} bytes required at offset ${offset}, ` +
      `${remainingByteLength} remaining`,
    );
  }
};
