// app/src/shared/types/data-types.ts

export interface MarketCandle {
  receivedAt: number;

  price: number;
  speed: number;
  acceleration: number;

  startedAt: number;
  endedAt: number;

  open: number;
  close: number;
  high: number;
  low: number;
}

export type IndicatorValue = number | null;

export interface MarketPhaseValue {
  position: number;
  speed: number;
  acceleration: number;
  surprise: number;
  residualVariance: number;
}

export interface MarketForecastValue {
  expectedReturn10s: IndicatorValue;
  expectedReturn30s: IndicatorValue;
  expectedReturn1m: IndicatorValue;
  expectedReturn2m: IndicatorValue;
  expectedReturn5m: IndicatorValue;
}
