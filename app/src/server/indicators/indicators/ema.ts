// app/src/server/indicators/indicators/ema.ts
import type {
  MarketIndicatorCalculationParams,
} from '../../types/market-indicators.js';
import {
  BaseIndicator,
} from '../base-indicator.js';

interface EmaIndicatorParams {
  period: number;
}

interface EmaIndicatorState {
  value: number;
  lastReceivedAt: number;
}

export class EmaIndicator extends BaseIndicator<EmaIndicatorState> {
  public readonly name: string;

  public constructor(
    private readonly params: EmaIndicatorParams,
  ) {
    super();

    this.name = `ema${params.period}`;
  }

  public calculate(
    params: MarketIndicatorCalculationParams,
  ): number | null {
    const latest = params.reversedCandles[0];

    if (!latest) {
      return this.stateByMarket.get(params.marketName)?.value ?? null;
    }

    const state = this.stateByMarket.get(params.marketName);

    if (state?.lastReceivedAt === latest.receivedAt) {
      return state.value;
    }

    if (!state) {
      return this.initialize(params);
    }

    const alpha = 2 / (this.params.period + 1);
    const value = state.value + alpha * (latest.close - state.value);

    this.stateByMarket.set(params.marketName, {
      value,
      lastReceivedAt: latest.receivedAt,
    });

    return value;
  }

  private initialize(
    params: MarketIndicatorCalculationParams,
  ): number | null {
    if (params.reversedCandles.length < this.params.period) {
      return null;
    }

    let sum = 0;

    for (let index = 0; index < this.params.period; index += 1) {
      const candle = params.reversedCandles[index];

      if (!candle) {
        return null;
      }

      sum += candle.close;
    }

    const latest = params.reversedCandles[0];

    if (!latest) {
      return null;
    }

    const value = sum / this.params.period;

    this.stateByMarket.set(params.marketName, {
      value,
      lastReceivedAt: latest.receivedAt,
    });

    return value;
  }
}
