import type {
  MarketStatisticsItem,
} from '../types/market-statistics-storage.js';
import {
  getMarketStatisticsItemByteLength,
  readMarketStatisticsItemFromDataView,
  writeMarketStatisticsItemToDataView,
} from './market-statistics-codec.js';

const encoder = new globalThis.TextEncoder();
const decoder = new globalThis.TextDecoder();

export type FullMarketStatisticsPayload = {
  marketName: string;
  levels: MarketStatisticsItem[][];
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
  levels: MarketStatisticsItem[][],
): ArrayBuffer => {
  const marketNameBytes = encoder.encode(marketName);
  const payloadByteLength = getFullMarketStatisticsPayloadByteLength(levels);

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

  for (const [level, items] of levels.entries()) {
    view.setUint16(offset, items.length, true);
    offset += 2;

    for (const item of items) {
      offset = writeMarketStatisticsItemToDataView(
        view,
        offset,
        level,
        item,
      );
    }
  }

  return buffer;
};

export const decodeFullMarketStatisticsPayload = (
  payload: ArrayBuffer,
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

  const levels: MarketStatisticsItem[][] = [];

  for (let level = 0; level < levelsLength; level += 1) {
    const itemsLength = view.getUint16(offset, true);
    offset += 2;

    const items: MarketStatisticsItem[] = [];

    for (let itemIndex = 0; itemIndex < itemsLength; itemIndex += 1) {
      const result = readMarketStatisticsItemFromDataView(
        view,
        offset,
        level,
      );

      items.push(result.item);
      offset = result.nextOffset;
    }

    levels.push(items);
  }

  return {
    marketName,
    levels,
  };
};

const getFullMarketStatisticsPayloadByteLength = (
  levels: MarketStatisticsItem[][],
): number => {
  return levels.reduce((sum, items, level) => {
    return sum + 2 + items.length * getMarketStatisticsItemByteLength(level);
  }, 0);
};
