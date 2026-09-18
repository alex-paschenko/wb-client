// app/src/server/entities/indicators/adaptive-ema.ts

import type { MarketCandle } from '../../../shared/types/data-types.js';
import { convertIntervalToTimeWithUnit } from '../../../shared/utilities/time.js';
import { RecursiveFilterIndicator } from './recursive-filter-indicator.js';

interface AdaptiveEmaIndicatorParams {
  tau: number;
  minTau: number;
  sensitivity: number;
}

export class AdaptiveEmaIndicator extends RecursiveFilterIndicator {
  private readonly minTau: number;
  private readonly sensitivity: number;

  public constructor(
    params: AdaptiveEmaIndicatorParams,
  ) {
    const { count, abbreviation } = convertIntervalToTimeWithUnit(params.tau);

    super(params.tau, `aEMA-${count}${abbreviation}`);

    if (
      !Number.isFinite(params.minTau) ||
      params.minTau <= 0 ||
      params.minTau > params.tau
    ) {
      throw new Error(
        'Adaptive EMA minTau must be positive and must not exceed tau',
      );
    }

    if (!Number.isFinite(params.sensitivity) || params.sensitivity < 0) {
      throw new Error(
        'Adaptive EMA sensitivity must be a non-negative finite number',
      );
    }

    this.minTau = params.minTau;
    this.sensitivity = params.sensitivity;
  }

  protected getInput(
    candle: MarketCandle,
  ): number | null {
    return Number.isFinite(candle.speed) ? candle.speed : null;
  }

  protected override getEffectiveTau(
    candle: MarketCandle,
  ): number {
    const priceScale = Math.abs(candle.price);

    if (
      priceScale === 0 ||
      !Number.isFinite(priceScale) ||
      !Number.isFinite(candle.acceleration)
    ) {
      return this.tau;
    }

    const normalizedAcceleration =
      Math.abs(candle.acceleration) * this.tau * this.tau / priceScale;

    const adaptiveTau = this.tau /
      ( 1 + this.sensitivity * normalizedAcceleration);

    return Math.max(this.minTau, adaptiveTau);
  }
}
