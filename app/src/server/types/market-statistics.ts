// app/src/server/types/market-statistics.ts
export interface MarketTick {
  receivedAt: number,
  price: number,
};

export const MARKET_CANDLE_FIELDS = [
  'startedAt',
  'endedAt',
  'timestampMs',
  'open',
  'close',
  'high',
  'low',
] as const;

export type MarketCandleField =
    typeof MARKET_CANDLE_FIELDS[number];

export const MARKET_CANDLE_FIELD_INDEX = {
    startedAt: 0,
    endedAt: 1,
    timestampMs: 2,
    open: 3,
    close: 4,
    high: 5,
    low: 6,
} as const satisfies Record<MarketCandleField, number>;

export const MARKET_CANDLE_FIELDS_PER_ITEM =
    MARKET_CANDLE_FIELDS.length;

export interface MarketRollingStatistics {
    receivedAt: number;


    open: number;
    close: number;
    high: number;
    low: number;

    stockVolume: number;
    moneyVolume: number;
}

export type MarketRollingStatisticsByMarket = Record<
    string,
    MarketRollingStatistics
>;
