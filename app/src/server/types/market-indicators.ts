import type {
  IndicatorResults,
  MarketIndicatorRecalculatedItem,
  MarketIndicatorStorageConfig,
} from '../../shared/types/market-indicators.js';
import type {
  ExtendedMarketDataView,
} from '../../shared/types/market-statistics-storage.js';

export interface MarketIndicatorResultsReader {
  getLast(name: string): number | null;

  getRecalculated(
    name: string,
  ): readonly MarketIndicatorRecalculatedItem[];
}

export interface MarketIndicatorCalculationParams
  extends ExtendedMarketDataView {
  results: MarketIndicatorResultsReader;
}

export interface MarketIndicator {
  readonly name: string;
  readonly dependencies: readonly string[];

  getStorageConfig(): MarketIndicatorStorageConfig;

  calculate(
    params: MarketIndicatorCalculationParams,
  ): IndicatorResults;

  removeMarket(marketName: string): void;
}
