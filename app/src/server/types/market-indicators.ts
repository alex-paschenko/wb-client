// app/src/server/types/market-indicators.ts
import type {
  MarketCandles,
} from '../../shared/types/market-statistics-storage.js';

export interface MarketIndicatorResultsReader {
  get(name: string): number | null;
}

export interface MarketIndicatorCalculationParams {
  marketName: string;
  candles: MarketCandles;
  reversedCandles: MarketCandles;
  results: MarketIndicatorResultsReader;
}

export interface MarketIndicator {
  readonly name: string;
  readonly dependencies: readonly string[];

  calculate(params: MarketIndicatorCalculationParams): number | null;
  removeMarket(marketName: string): void;
}
