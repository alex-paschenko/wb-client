// app/src/server/types/market-indicators.ts
import type { IndicatorValue } from '../../shared/types/data-types.js';
import type { EntityDesriptor } from '../../shared/types/storage-entities.js';
import type { ExtendedMarketDataView } from '../../shared/types/storage-old.js';

export type MarketIndicatorCalculationParams = ExtendedMarketDataView;

export interface MarketIndicator {
  readonly descriptor: EntityDesriptor<IndicatorValue>;
  readonly dependencies: readonly string[];

  calculate(
    params: MarketIndicatorCalculationParams,
  ): void;

  removeMarket(marketName: string): void;
}
