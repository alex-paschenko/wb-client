// app/src/server/indicators/incremental-indicator.ts

import { IndicatorValue } from '../../shared/types/market-indicators.js';
import type {
  MarketIndicatorCalculationParams,
} from '../types/market-indicators.js';
import { BaseIndicator } from './base-indicator.js';

export abstract class IncrementalIndicator<TState>
  extends BaseIndicator<TState> {
  public singleCalculate(
    params: MarketIndicatorCalculationParams,
  ): IndicatorValue {
    return this.stateByMarket.has(params.marketName)
      ? this.incrementalCalculate(params)
      : this.fullCalculate(params);
  }

  protected abstract incrementalCalculate(
    params: MarketIndicatorCalculationParams,
  ): IndicatorValue;

  protected abstract fullCalculate(
    params: MarketIndicatorCalculationParams,
  ): IndicatorValue;
}
