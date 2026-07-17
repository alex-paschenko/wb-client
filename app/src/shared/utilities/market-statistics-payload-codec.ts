// app/src/shared/utilities/market-statistics-payload-codec.ts
import type {
  MarketIndicatorsRegistry,
  MarketIndicatorValues,
} from '../types/market-indicators.js';
import type {
  FullMarketStatisticsLevel,
  MarketCandle,
} from '../types/market-statistics-storage.js';
import {
  getIndicatorValueByteLength,
  readIndicatorValue,
  writeIndicatorValue,
} from './market-indicators-codec.js';
import {
  getMarketCandleByteLength,
  readMarketCandleFromDataView,
  writeMarketCandleToDataView,
} from './market-statistics-codec.js';

const encoder = new globalThis.TextEncoder();
const decoder = new globalThis.TextDecoder();

export type FullMarketStatisticsPayload = {
  marketName: string;
  levels: FullMarketStatisticsLevel[];
};

export type MarketStatisticsDeltaPayload = {
  marketName: string;
  delta: ArrayBuffer;
};

export const encodeMarketStatisticsDeltaPayload = (
  marketName: string,
  delta: ArrayBuffer,
): ArrayBuffer => {
  const marketNameBytes = encoder.encode(marketName);

  const byteLength =
    2 +
    marketNameBytes.byteLength +
    delta.byteLength;

  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let offset = 0;

  view.setUint16(offset, marketNameBytes.byteLength, true);
  offset += 2;

  bytes.set(marketNameBytes, offset);
  offset += marketNameBytes.byteLength;

  bytes.set(new Uint8Array(delta), offset);

  return buffer;
};

export const decodeMarketStatisticsDeltaPayload = (
  payload: ArrayBuffer,
): MarketStatisticsDeltaPayload => {
  const view = new DataView(payload);
  const bytes = new Uint8Array(payload);

  let offset = 0;

  const marketNameByteLength = view.getUint16(offset, true);
  offset += 2;

  const marketName = decoder.decode(
    bytes.slice(offset, offset + marketNameByteLength),
  );
  offset += marketNameByteLength;

  return {
    marketName,
    delta: payload.slice(offset),
  };
};

export const encodeFullMarketStatisticsPayload = (
  marketName: string,
  levels: readonly FullMarketStatisticsLevel[],
  indicatorRegistry: MarketIndicatorsRegistry,
): ArrayBuffer => {
  const marketNameBytes = encoder.encode(marketName);

  if (marketNameBytes.byteLength > 0xffff) {
    throw new Error(
      `Market name is too long to encode: ${marketNameBytes.byteLength} bytes`,
    );
  }

  if (levels.length > 0xff) {
    throw new Error(
      `Too many market statistics levels: ${levels.length}`,
    );
  }

  const payloadByteLength =
    getFullMarketStatisticsPayloadByteLength(
      levels,
      indicatorRegistry,
    );

  const byteLength =
    2 +
    marketNameBytes.byteLength +
    1 +
    payloadByteLength;

  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let offset = 0;

  view.setUint16(offset, marketNameBytes.byteLength, true);
  offset += 2;

  bytes.set(marketNameBytes, offset);
  offset += marketNameBytes.byteLength;

  view.setUint8(offset, levels.length);
  offset += 1;

  for (const [level, data] of levels.entries()) {
    if (data.candles.length !== data.indicators.length) {
      throw new Error(
        `Cannot encode market statistics level ${level}: ` +
        `candles length ${data.candles.length} does not match ` +
        `indicators length ${data.indicators.length}`,
      );
    }

    if (data.candles.length > 0xffff) {
      throw new Error(
        `Market statistics level ${level} is too large: ` +
        `${data.candles.length} items`,
      );
    }

    view.setUint16(offset, data.candles.length, true);
    offset += 2;

    for (const candle of data.candles) {
      offset = writeMarketCandleToDataView(
        view,
        offset,
        level,
        candle,
      );
    }

    for (const indicatorConfig of indicatorRegistry) {
      for (const indicators of data.indicators) {
        offset = writeIndicatorValue(
          view,
          offset,
          indicatorConfig.codecIndex,
          indicators[indicatorConfig.name] ?? null,
        );
      }
    }
  }

  return buffer;
};

export const decodeFullMarketStatisticsPayload = (
  payload: ArrayBuffer,
  indicatorRegistry: MarketIndicatorsRegistry,
): FullMarketStatisticsPayload => {
  const view = new DataView(payload);
  const bytes = new Uint8Array(payload);

  let offset = 0;

  const marketNameByteLength = view.getUint16(offset, true);
  offset += 2;

  const marketName = decoder.decode(
    bytes.slice(offset, offset + marketNameByteLength),
  );
  offset += marketNameByteLength;

  const levelsLength = view.getUint8(offset);
  offset += 1;

  const levels: FullMarketStatisticsLevel[] = [];

  for (let level = 0; level < levelsLength; level += 1) {
    const itemsLength = view.getUint16(offset, true);
    offset += 2;

    const candles: MarketCandle[] = [];

    for (
      let itemIndex = 0;
      itemIndex < itemsLength;
      itemIndex += 1
    ) {
      const result = readMarketCandleFromDataView(
        view,
        offset,
        level,
      );

      candles.push(result.item);
      offset = result.nextOffset;
    }

    const indicators: MarketIndicatorValues[] =
      Array.from(
        { length: itemsLength },
        () => ({}),
      );

    for (const indicatorConfig of indicatorRegistry) {
      for (
        let itemIndex = 0;
        itemIndex < itemsLength;
        itemIndex += 1
      ) {
        const result = readIndicatorValue(
          view,
          offset,
          indicatorConfig.codecIndex,
        );

        indicators[itemIndex][indicatorConfig.name] =
          result.value;

        offset = result.nextOffset;
      }
    }

    levels.push({
      candles,
      indicators,
    });
  }

  if (offset !== payload.byteLength) {
    throw new Error(
      `Full market statistics payload was not read completely: ` +
      `${payload.byteLength - offset} trailing bytes`,
    );
  }

  return {
    marketName,
    levels,
  };
};

const getFullMarketStatisticsPayloadByteLength = (
  levels: readonly FullMarketStatisticsLevel[],
  indicatorRegistry: MarketIndicatorsRegistry,
): number => {
  const indicatorItemByteLength =
    indicatorRegistry.reduce(
      (sum, indicatorConfig) =>
        sum +
        getIndicatorValueByteLength(
          indicatorConfig.codecIndex,
        ),
      0,
    );

  return levels.reduce((sum, data, level) => {
    if (data.candles.length !== data.indicators.length) {
      throw new Error(
        `Cannot calculate market statistics level ${level} byte length: ` +
        `candles length ${data.candles.length} does not match ` +
        `indicators length ${data.indicators.length}`,
      );
    }

    const itemsByteLength =
      data.candles.length *
      (
        getMarketCandleByteLength(level) +
        indicatorItemByteLength
      );

    return sum + 2 + itemsByteLength;
  }, 0);
};
