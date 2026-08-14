// app/src/shared/utilities/market-statistics-indicator-changes-codec.ts

import type {
  MarketIndicatorsRegistry,
} from '../types/market-indicators.js';
import type {
  ChangedIndicatorInterval,
  ChangedIndicatorIntervalsByName,
} from '../types/market-statistic-accessors.js';
import {
  getIndicatorValueByteLength,
} from './market-indicators-codec.js';

export type GetIndicatorChunk = (
  indicatorName: string,
  level: number,
  chunkIndex: number,
) => Uint8Array;

const INDICATORS_COUNT_BYTES = 2;
const INDICATOR_NAME_LENGTH_BYTES = 2;
const INTERVALS_COUNT_BYTES = 2;

const INTERVAL_LEVEL_BYTES = 1;
const INTERVAL_CHUNK_INDEX_BYTES = 2;
const INTERVAL_ITEM_INDEX_BYTES = 2;
const INTERVAL_ITEM_COUNT_BYTES = 2;

const INTERVAL_DESCRIPTOR_BYTES =
  INTERVAL_LEVEL_BYTES +
  INTERVAL_CHUNK_INDEX_BYTES +
  INTERVAL_ITEM_INDEX_BYTES +
  INTERVAL_ITEM_COUNT_BYTES;

const encoder = new globalThis.TextEncoder();
const decoder = new globalThis.TextDecoder();

const encodedIndicatorNames = new Map<string, Uint8Array>();

export const encodeMarketStatisticsIndicatorChanges = (
  intervalsByIndicator: ChangedIndicatorIntervalsByName,
  indicatorRegistry: MarketIndicatorsRegistry,
  getIndicatorChunk: GetIndicatorChunk,
): ArrayBuffer | null => {
  if (intervalsByIndicator.size === 0) {
    return null;
  }

  if (intervalsByIndicator.size > 0xffff) {
    throw new Error(
      `Too many changed indicators: ${intervalsByIndicator.size}`,
    );
  }

  const byteLength = getIndicatorChangesByteLength(
    intervalsByIndicator,
    indicatorRegistry,
  );

  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let offset = 0;

  view.setUint16(offset, intervalsByIndicator.size, true);
  offset += INDICATORS_COUNT_BYTES;

  for (const [indicatorName, intervals] of intervalsByIndicator) {
    const indicatorConfig = getIndicatorConfig(
      indicatorName,
      indicatorRegistry,
    );

    const valueByteLength =
      getIndicatorValueByteLength(indicatorConfig.codecIndex);

    const indicatorNameBytes = getEncodedIndicatorName(indicatorName);

    if (indicatorNameBytes.byteLength > 0xffff) {
      throw new Error(
        `Indicator name is too long: "${indicatorName}"`,
      );
    }

    if (intervals.length > 0xffff) {
      throw new Error(
        `Too many changed intervals for indicator ` +
        `"${indicatorName}": ${intervals.length}`,
      );
    }

    view.setUint16(offset, indicatorNameBytes.byteLength, true);
    offset += INDICATOR_NAME_LENGTH_BYTES;

    bytes.set(indicatorNameBytes, offset);
    offset += indicatorNameBytes.byteLength;

    view.setUint16(offset, intervals.length, true);
    offset += INTERVALS_COUNT_BYTES;

    for (const interval of intervals) {
      validateInterval(interval, indicatorName);

      view.setUint8(offset, interval.level);
      offset += INTERVAL_LEVEL_BYTES;

      view.setUint16(offset, interval.chunkIndex, true);
      offset += INTERVAL_CHUNK_INDEX_BYTES;

      view.setUint16(offset, interval.itemIndex, true);
      offset += INTERVAL_ITEM_INDEX_BYTES;

      view.setUint16(offset, interval.itemCount, true);
      offset += INTERVAL_ITEM_COUNT_BYTES;

      const chunk = getIndicatorChunk(
        indicatorName,
        interval.level,
        interval.chunkIndex,
      );

      const sourceOffset = interval.itemIndex * valueByteLength;
      const sourceLength = interval.itemCount * valueByteLength;
      const sourceEnd = sourceOffset + sourceLength;

      if (sourceEnd > chunk.byteLength) {
        throw new Error(
          `Changed indicator interval exceeds chunk bounds: ` +
          `"${indicatorName}", level ${interval.level}, ` +
          `chunk ${interval.chunkIndex}, item ${interval.itemIndex}, ` +
          `count ${interval.itemCount}`,
        );
      }

      bytes.set(chunk.subarray(sourceOffset, sourceEnd), offset);
      offset += sourceLength;
    }
  }

  if (offset !== byteLength) {
    throw new Error(
      `Indicator changes byte length mismatch: ` +
      `expected ${byteLength}, written ${offset}`,
    );
  }

  return buffer;
};

export const applyMarketStatisticsIndicatorChanges = (
  buffer: Uint8Array,
  indicatorRegistry: MarketIndicatorsRegistry,
  getIndicatorChunk: GetIndicatorChunk,
): void => {
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  const bytes = buffer;

  ensureRemainingBytes(view, 0, INDICATORS_COUNT_BYTES);

  let offset = 0;

  const indicatorsCount = view.getUint16(offset, true);
  offset += INDICATORS_COUNT_BYTES;

  for (let indicatorIndex = 0; indicatorIndex < indicatorsCount; indicatorIndex++) {
    ensureRemainingBytes(view, offset, INDICATOR_NAME_LENGTH_BYTES);

    const nameByteLength = view.getUint16(offset, true);
    offset += INDICATOR_NAME_LENGTH_BYTES;

    ensureRemainingBytes(view, offset, nameByteLength);

    const indicatorName = decoder.decode(
      bytes.subarray(offset, offset + nameByteLength),
    );
    offset += nameByteLength;

    const indicatorConfig = getIndicatorConfig(
      indicatorName,
      indicatorRegistry,
    );

    const valueByteLength =
      getIndicatorValueByteLength(indicatorConfig.codecIndex);

    ensureRemainingBytes(view, offset, INTERVALS_COUNT_BYTES);

    const intervalsCount = view.getUint16(offset, true);
    offset += INTERVALS_COUNT_BYTES;

    for (let intervalIndex = 0; intervalIndex < intervalsCount; intervalIndex++) {
      ensureRemainingBytes(view, offset, INTERVAL_DESCRIPTOR_BYTES);

      const level = view.getUint8(offset);
      offset += INTERVAL_LEVEL_BYTES;

      const chunkIndex = view.getUint16(offset, true);
      offset += INTERVAL_CHUNK_INDEX_BYTES;

      const itemIndex = view.getUint16(offset, true);
      offset += INTERVAL_ITEM_INDEX_BYTES;

      const itemCount = view.getUint16(offset, true);
      offset += INTERVAL_ITEM_COUNT_BYTES;

      if (itemCount === 0) {
        throw new Error(
          `Indicator change interval cannot be empty: ` +
          `"${indicatorName}", level ${level}, chunk ${chunkIndex}`,
        );
      }

      const sourceLength = itemCount * valueByteLength;

      ensureRemainingBytes(view, offset, sourceLength);

      const chunk = getIndicatorChunk(
        indicatorName,
        level,
        chunkIndex,
      );

      const targetOffset = itemIndex * valueByteLength;
      const targetEnd = targetOffset + sourceLength;

      if (targetEnd > chunk.byteLength) {
        throw new Error(
          `Indicator change interval exceeds target chunk bounds: ` +
          `"${indicatorName}", level ${level}, chunk ${chunkIndex}, ` +
          `item ${itemIndex}, count ${itemCount}`,
        );
      }

      chunk.set(
        bytes.subarray(offset, offset + sourceLength),
        targetOffset,
      );

      offset += sourceLength;
    }
  }

  if (offset !== buffer.byteLength) {
    throw new Error(
      `Indicator changes buffer was not read completely: ` +
      `${buffer.byteLength - offset} trailing bytes`,
    );
  }
};

const getIndicatorChangesByteLength = (
  intervalsByIndicator: ChangedIndicatorIntervalsByName,
  indicatorRegistry: MarketIndicatorsRegistry,
): number => {
  let byteLength = INDICATORS_COUNT_BYTES;

  for (const [indicatorName, intervals] of intervalsByIndicator) {
    const indicatorConfig = getIndicatorConfig(
      indicatorName,
      indicatorRegistry,
    );

    const valueByteLength =
      getIndicatorValueByteLength(indicatorConfig.codecIndex);

    const indicatorNameBytes = getEncodedIndicatorName(indicatorName);

    byteLength +=
      INDICATOR_NAME_LENGTH_BYTES +
      indicatorNameBytes.byteLength +
      INTERVALS_COUNT_BYTES;

    for (const interval of intervals) {
      validateInterval(interval, indicatorName);

      byteLength +=
        INTERVAL_DESCRIPTOR_BYTES +
        interval.itemCount * valueByteLength;
    }
  }

  return byteLength;
};

const getEncodedIndicatorName = (indicatorName: string): Uint8Array => {
  const existing = encodedIndicatorNames.get(indicatorName);

  if (existing) {
    return existing;
  }

  const encoded = encoder.encode(indicatorName);
  encodedIndicatorNames.set(indicatorName, encoded);

  return encoded;
};

const getIndicatorConfig = (
  indicatorName: string,
  indicatorRegistry: MarketIndicatorsRegistry,
) => {
  const config = indicatorRegistry.find(
    (indicator) => indicator.name === indicatorName,
  );

  if (!config) {
    throw new Error(`Unknown indicator "${indicatorName}"`);
  }

  return config;
};

const validateInterval = (
  interval: ChangedIndicatorInterval,
  indicatorName: string,
): void => {
  if (!Number.isInteger(interval.level) ||
      interval.level < 0 ||
      interval.level > 0xff) {
    throw new Error(
      `Invalid level for indicator "${indicatorName}": ${interval.level}`,
    );
  }

  if (!Number.isInteger(interval.chunkIndex) ||
      interval.chunkIndex < 0 ||
      interval.chunkIndex > 0xffff) {
    throw new Error(
      `Invalid chunk index for indicator "${indicatorName}": ` +
      `${interval.chunkIndex}`,
    );
  }

  if (!Number.isInteger(interval.itemIndex) ||
      interval.itemIndex < 0 ||
      interval.itemIndex > 0xffff) {
    throw new Error(
      `Invalid item index for indicator "${indicatorName}": ` +
      `${interval.itemIndex}`,
    );
  }

  if (!Number.isInteger(interval.itemCount) ||
      interval.itemCount <= 0 ||
      interval.itemCount > 0xffff) {
    throw new Error(
      `Invalid item count for indicator "${indicatorName}": ` +
      `${interval.itemCount}`,
    );
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
      `Unexpected end of indicator changes buffer: ` +
      `${requiredByteLength} bytes required at offset ${offset}, ` +
      `${remainingByteLength} remaining`,
    );
  }
};
