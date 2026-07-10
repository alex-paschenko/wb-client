// app/src/server/types/market-indicators.ts
import type {
  IndicatorResults,
  MarketIndicatorStorageConfig,
} from '../../shared/types/market-indicators.js';

import type {
  ExtendedMarketDataView,
} from '../../shared/types/market-statistics-storage.js';

export interface MarketIndicatorResultsReader {
  get(name: string): number | null;
}

export interface MarketIndicatorCalculationParams
  extends ExtendedMarketDataView {
    results: MarketIndicatorResultsReader;
  }

export interface MarketIndicatorCalculationParams
  extends ExtendedMarketDataView {
  results: MarketIndicatorResultsReader;
}

export interface MarketIndicator {
  readonly name: string;
  readonly dependencies: readonly string[];

  getStorageConfig(): MarketIndicatorStorageConfig;

  calculate(params: MarketIndicatorCalculationParams): IndicatorResults;

  removeMarket(marketName: string): void;
}