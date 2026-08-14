// app/src/server/types/market-indicators.ts
import type {
  MarketIndicatorStorageConfig,
} from '../../shared/types/market-indicators.js';
import type {
  ExtendedMarketDataView,
} from '../../shared/types/market-statistics-storage.js';

export type MarketIndicatorCalculationParams = ExtendedMarketDataView;

export interface MarketIndicator {
  readonly name: string;
  readonly dependencies: readonly string[];

  getStorageConfig(): MarketIndicatorStorageConfig;

  calculate(
    params: MarketIndicatorCalculationParams,
  ): void;

  removeMarket(marketName: string): void;
}
