import {
  MARKET_STATISTICS_LEVEL_CONFIGS,
} from '../constants/market-statistics-config.js';
import type {
  MarketCandle,
  MarketSnapshot,
  MarketStatisticsItem,
} from '../types/market-statistics-storage.js';
import { getGenerateSerials } from './generate-serials.js';

export const MARKET_STATISTICS_SNAPSHOT_FIELDS_PER_ITEM = 3;
export const MARKET_STATISTICS_CANDLE_FIELDS_PER_ITEM = 9;
export const MARKET_STATISTICS_FIELD_BYTES = Float64Array.BYTES_PER_ELEMENT;

export const getMarketStatisticsFieldsPerItem = (level: number): number => {
  const config = MARKET_STATISTICS_LEVEL_CONFIGS[level];

  if (!config) {
    throw new Error(`Unknown market statistics level: ${level}`);
  }

  return config.sourceType === 'snapshot'
    ? MARKET_STATISTICS_SNAPSHOT_FIELDS_PER_ITEM
    : MARKET_STATISTICS_CANDLE_FIELDS_PER_ITEM;
};

export const getMarketStatisticsItemByteLength = (level: number): number =>
  getMarketStatisticsFieldsPerItem(level) * MARKET_STATISTICS_FIELD_BYTES;

export const writeMarketStatisticsItemToDataView = (
  view: DataView,
  offset: number,
  level: number,
  item: MarketStatisticsItem,
): number => {
  const config = MARKET_STATISTICS_LEVEL_CONFIGS[level];

  if (!config) {
    throw new Error(`Unknown market statistics level: ${level}`);
  }

  const offsetCounter = getGenerateSerials(offset, MARKET_STATISTICS_FIELD_BYTES);
  const setField = (value: number) =>
    view.setFloat64(offsetCounter.next().value, value, true);

  if (config.sourceType === 'snapshot') {
    const snapshot = item as MarketSnapshot;

    setField(snapshot.receivedAt);
    setField(snapshot.price);
    setField(snapshot.speed);

    return offsetCounter.next().value;
  }

  const candle = item as MarketCandle;

  setField(candle.receivedAt);
  setField(candle.price);
  setField(candle.speed);
  setField(candle.startedAt);
  setField(candle.endedAt);
  setField(candle.open);
  setField(candle.close);
  setField(candle.high);
  setField(candle.low);

  return offsetCounter.next().value;
};

export const readMarketStatisticsItemFromDataView = (
  view: DataView,
  offset: number,
  level: number,
): {
  item: MarketStatisticsItem;
  nextOffset: number;
} => {
  const config = MARKET_STATISTICS_LEVEL_CONFIGS[level];

  if (!config) {
    throw new Error(`Unknown market statistics level: ${level}`);
  }

  const offsetCounter = getGenerateSerials(offset, MARKET_STATISTICS_FIELD_BYTES);
  const getField = () => view.getFloat64(offsetCounter.next().value, true);

  if (config.sourceType === 'snapshot') {
    const receivedAt = getField();
    const price = getField();
    const speed = getField();

    return {
      item: { receivedAt, price, speed },
      nextOffset: offsetCounter.next().value,
    };
  }

  const receivedAt = getField();
  const price = getField();
  const speed = getField();
  const startedAt = getField();
  const endedAt = getField();
  const open = getField();
  const close = getField();
  const high = getField();
  const low = getField();

  return {
    item: {
      receivedAt,
      price,
      speed,
      startedAt,
      endedAt,
      open,
      close,
      high,
      low,
    },
    nextOffset: offsetCounter.next().value,
  };
};

export const writeMarketStatisticsItemToFloat64Array = (
  data: Float64Array,
  itemIndex: number,
  level: number,
  item: MarketStatisticsItem,
): void => {
  const config = MARKET_STATISTICS_LEVEL_CONFIGS[level];

  if (!config) {
    throw new Error(`Unknown market statistics level: ${level}`);
  }

  const offset = itemIndex * getMarketStatisticsFieldsPerItem(level);
  const offsetCounter = getGenerateSerials(offset, 1);
  const setField = (value: number) => {
    data[offsetCounter.next().value] = value;
  };

  if (config.sourceType === 'snapshot') {
    const snapshot = item as MarketSnapshot;

    setField(snapshot.receivedAt);
    setField(snapshot.price);
    setField(snapshot.speed);

    return;
  }

  const candle = item as MarketCandle;

  setField(candle.receivedAt);
  setField(candle.price);
  setField(candle.speed);
  setField(candle.startedAt);
  setField(candle.endedAt);
  setField(candle.open);
  setField(candle.close);
  setField(candle.high);
  setField(candle.low);
};

export const readMarketStatisticsItemFromFloat64Array = (
  data: Float64Array,
  itemIndex: number,
  level: number,
): MarketStatisticsItem => {
  const config = MARKET_STATISTICS_LEVEL_CONFIGS[level];

  if (!config) {
    throw new Error(`Unknown market statistics level: ${level}`);
  }

  const offset = itemIndex * getMarketStatisticsFieldsPerItem(level);
  const offsetCounter = getGenerateSerials(offset, 1);
  const getField = () => data[offsetCounter.next().value];

  if (config.sourceType === 'snapshot') {
    return {
      receivedAt: getField(),
      price: getField(),
      speed: getField(),
    };
  }

  return {
    receivedAt: getField(),
    price: getField(),
    speed: getField(),
    startedAt: getField(),
    endedAt: getField(),
    open: getField(),
    close: getField(),
    high: getField(),
    low: getField(),
  };
};
