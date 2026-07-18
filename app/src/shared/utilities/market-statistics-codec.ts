// shared/utilities/market-statistics-codec.ts

import type {
  MarketCandle,
} from '../types/market-statistics-storage.js';

export const MARKET_STATISTICS_FIELD_BYTES =
  Float64Array.BYTES_PER_ELEMENT;

export const MARKET_STATISTICS_LAYOUT = {
  receivedAt: 0,
  price: 1,
  speed: 2,
  startedAt: 3,
  endedAt: 4,
  open: 5,
  close: 6,
  high: 7,
  low: 8,
} as const satisfies Record<keyof MarketCandle, number>;

export const MARKET_STATISTICS_CANDLE_FIELDS_PER_ITEM =
  Object.keys(MARKET_STATISTICS_LAYOUT).length;

const buildMarketStatisticsFieldOffsets = (
  layout: Record<keyof MarketCandle, number>,
): Record<keyof MarketCandle, number> =>
  Object.fromEntries(
    Object.entries(layout).map(
      ([fieldName, fieldIndex]) => [
        fieldName,
        fieldIndex * MARKET_STATISTICS_FIELD_BYTES,
      ],
    ),
  ) as Record<keyof MarketCandle, number>;

const MARKET_STATISTICS_FIELD_OFFSETS =
  buildMarketStatisticsFieldOffsets(
    MARKET_STATISTICS_LAYOUT,
  );

export const getMarketStatisticsFieldsPerItem = (
  level: number,
): number => {
  void level;

  return MARKET_STATISTICS_CANDLE_FIELDS_PER_ITEM;
};

export const getMarketCandleByteLength = (
  level: number,
): number =>
  getMarketStatisticsFieldsPerItem(level) *
  MARKET_STATISTICS_FIELD_BYTES;

export const writeMarketCandleToDataView = (
  view: DataView,
  offset: number,
  level: number,
  item: MarketCandle,
): number => {
  view.setFloat64(
    offset + MARKET_STATISTICS_FIELD_OFFSETS.receivedAt,
    item.receivedAt,
    true,
  );

  view.setFloat64(
    offset + MARKET_STATISTICS_FIELD_OFFSETS.price,
    item.price,
    true,
  );

  view.setFloat64(
    offset + MARKET_STATISTICS_FIELD_OFFSETS.speed,
    item.speed,
    true,
  );

  view.setFloat64(
    offset + MARKET_STATISTICS_FIELD_OFFSETS.startedAt,
    item.startedAt,
    true,
  );

  view.setFloat64(
    offset + MARKET_STATISTICS_FIELD_OFFSETS.endedAt,
    item.endedAt,
    true,
  );

  view.setFloat64(
    offset + MARKET_STATISTICS_FIELD_OFFSETS.open,
    item.open,
    true,
  );

  view.setFloat64(
    offset + MARKET_STATISTICS_FIELD_OFFSETS.close,
    item.close,
    true,
  );

  view.setFloat64(
    offset + MARKET_STATISTICS_FIELD_OFFSETS.high,
    item.high,
    true,
  );

  view.setFloat64(
    offset + MARKET_STATISTICS_FIELD_OFFSETS.low,
    item.low,
    true,
  );

  return offset + getMarketCandleByteLength(level);
};

export const readMarketCandleFromDataView = (
  view: DataView,
  offset: number,
  level: number,
): {
  item: MarketCandle;
  nextOffset: number;
} => ({
  item: {
    receivedAt: view.getFloat64(
      offset + MARKET_STATISTICS_FIELD_OFFSETS.receivedAt,
      true,
    ),
    price: view.getFloat64(
      offset + MARKET_STATISTICS_FIELD_OFFSETS.price,
      true,
    ),
    speed: view.getFloat64(
      offset + MARKET_STATISTICS_FIELD_OFFSETS.speed,
      true,
    ),
    startedAt: view.getFloat64(
      offset + MARKET_STATISTICS_FIELD_OFFSETS.startedAt,
      true,
    ),
    endedAt: view.getFloat64(
      offset + MARKET_STATISTICS_FIELD_OFFSETS.endedAt,
      true,
    ),
    open: view.getFloat64(
      offset + MARKET_STATISTICS_FIELD_OFFSETS.open,
      true,
    ),
    close: view.getFloat64(
      offset + MARKET_STATISTICS_FIELD_OFFSETS.close,
      true,
    ),
    high: view.getFloat64(
      offset + MARKET_STATISTICS_FIELD_OFFSETS.high,
      true,
    ),
    low: view.getFloat64(
      offset + MARKET_STATISTICS_FIELD_OFFSETS.low,
      true,
    ),
  },
  nextOffset: offset + getMarketCandleByteLength(level),
});

export const writeMarketCandleToFloat64Array = (
  data: Float64Array,
  itemIndex: number,
  level: number,
  item: MarketCandle,
): void => {
  const offset =
    itemIndex * getMarketStatisticsFieldsPerItem(level);

  data[
    offset + MARKET_STATISTICS_LAYOUT.receivedAt
  ] = item.receivedAt;

  data[
    offset + MARKET_STATISTICS_LAYOUT.price
  ] = item.price;

  data[
    offset + MARKET_STATISTICS_LAYOUT.speed
  ] = item.speed;

  data[
    offset + MARKET_STATISTICS_LAYOUT.startedAt
  ] = item.startedAt;

  data[
    offset + MARKET_STATISTICS_LAYOUT.endedAt
  ] = item.endedAt;

  data[
    offset + MARKET_STATISTICS_LAYOUT.open
  ] = item.open;

  data[
    offset + MARKET_STATISTICS_LAYOUT.close
  ] = item.close;

  data[
    offset + MARKET_STATISTICS_LAYOUT.high
  ] = item.high;

  data[
    offset + MARKET_STATISTICS_LAYOUT.low
  ] = item.low;
};

export const readMarketCandleFromFloat64Array = (
  data: Float64Array,
  itemIndex: number,
  level: number,
): MarketCandle => {
  const offset =
    itemIndex * getMarketStatisticsFieldsPerItem(level);

  return {
    receivedAt:
      data[
        offset + MARKET_STATISTICS_LAYOUT.receivedAt
      ],
    price:
      data[
        offset + MARKET_STATISTICS_LAYOUT.price
      ],
    speed:
      data[
        offset + MARKET_STATISTICS_LAYOUT.speed
      ],
    startedAt:
      data[
        offset + MARKET_STATISTICS_LAYOUT.startedAt
      ],
    endedAt:
      data[
        offset + MARKET_STATISTICS_LAYOUT.endedAt
      ],
    open:
      data[
        offset + MARKET_STATISTICS_LAYOUT.open
      ],
    close:
      data[
        offset + MARKET_STATISTICS_LAYOUT.close
      ],
    high:
      data[
        offset + MARKET_STATISTICS_LAYOUT.high
      ],
    low:
      data[
        offset + MARKET_STATISTICS_LAYOUT.low
      ],
  };
};

export const readMarketCandleField = <
  TFieldName extends keyof MarketCandle,
>(
  data: Float64Array,
  itemIndex: number,
  level: number,
  fieldName: TFieldName,
): MarketCandle[TFieldName] => {
  const offset =
    itemIndex * getMarketStatisticsFieldsPerItem(level);

  return data[
    offset + MARKET_STATISTICS_LAYOUT[fieldName]
  ] as MarketCandle[TFieldName];
};

export const readMarketCandleFields = <
  const TFieldNames extends readonly (keyof MarketCandle)[],
>(
  data: Float64Array,
  itemIndex: number,
  level: number,
  ...fieldNames: TFieldNames
): Pick<MarketCandle, TFieldNames[number]> => {
  const offset =
    itemIndex * getMarketStatisticsFieldsPerItem(level);

  const result: Partial<MarketCandle> = {};

  for (const fieldName of fieldNames) {
    result[fieldName] =
      data[
        offset + MARKET_STATISTICS_LAYOUT[fieldName]
      ];
  }

  return result as Pick<
    MarketCandle,
    TFieldNames[number]
  >;
};
