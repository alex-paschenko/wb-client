// app/src/server/indicators/incremental-indicator.ts
import type {
  MarketIndicatorCalculationParams,
} from '../types/market-indicators.js';

import {
  BaseIndicator,
} from './base-indicator.js';

export abstract class IncrementalIndicator<TState>
  extends BaseIndicator<TState> {
  public singleCalculate(
    params: MarketIndicatorCalculationParams,
  ): number | null {
    return this.stateByMarket.has(params.marketName)
      ? this.incrementalCalculate(params)
      : this.fullCalculate(params);
  }

  protected abstract incrementalCalculate(
    params: MarketIndicatorCalculationParams,
  ): number | null;

  protected abstract fullCalculate(
    params: MarketIndicatorCalculationParams,
  ): number | null;
}
