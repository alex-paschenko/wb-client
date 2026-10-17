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
  // Expected 60 s EMA residual, in promille; not a raw trade return.
  expectedResidual1m3Ema: IndicatorValue;
  expectedResidual1m4Ema: IndicatorValue;
  expectedResidual1mCombined: IndicatorValue;
}
