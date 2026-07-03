import type {
  MarketCandle,
} from '../types/market-statistics-storage.js';
import { getGenerateSerials } from './generate-serials.js';

export const MARKET_STATISTICS_SNAPSHOT_FIELDS_PER_ITEM = 3;
export const MARKET_STATISTICS_CANDLE_FIELDS_PER_ITEM = 9;
export const MARKET_STATISTICS_FIELD_BYTES = Float64Array.BYTES_PER_ELEMENT;

export const getMarketStatisticsFieldsPerItem = (level: number): number => {

  return MARKET_STATISTICS_CANDLE_FIELDS_PER_ITEM;
};

export const getMarketCandleByteLength = (level: number): number =>
  getMarketStatisticsFieldsPerItem(level) * MARKET_STATISTICS_FIELD_BYTES;

export const writeMarketCandleToDataView = (
  view: DataView,
  offset: number,
  level: number,
  item: MarketCandle,
): number => {
  const offsetCounter = getGenerateSerials(offset, MARKET_STATISTICS_FIELD_BYTES);
  const setField = (value: number) =>
    view.setFloat64(offsetCounter.next().value, value, true);

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

export const readMarketCandleFromDataView = (
  view: DataView,
  offset: number,
  level: number,
): {
  item: MarketCandle;
  nextOffset: number;
} => {
  const offsetCounter = getGenerateSerials(offset, MARKET_STATISTICS_FIELD_BYTES);
  const getField = () => view.getFloat64(offsetCounter.next().value, true);

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

export const writeMarketCandleToFloat64Array = (
  data: Float64Array,
  itemIndex: number,
  level: number,
  item: MarketCandle,
): void => {
  const offset = itemIndex * getMarketStatisticsFieldsPerItem(level);
  const offsetCounter = getGenerateSerials(offset, 1);
  const setField = (value: number) => {
    data[offsetCounter.next().value] = value;
  };

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

export const readMarketCandleFromFloat64Array = (
  data: Float64Array,
  itemIndex: number,
  level: number,
): MarketCandle => {
  const offset = itemIndex * getMarketStatisticsFieldsPerItem(level);
  const offsetCounter = getGenerateSerials(offset, 1);
  const getField = () => data[offsetCounter.next().value];

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
