// app/src/server/indicators/indicators/rca.ts
import type {
  MarketIndicatorCalculationParams,
} from '../../types/market-indicators.js';
import {
  BaseIndicator,
} from '../base-indicator.js';

interface RcaIndicatorParams {
  period: number;
}

interface RcaIndicatorState {
  value: number;
  sum: number;
  lastReceivedAt: number;
}

export class RcaIndicator extends BaseIndicator<RcaIndicatorState> {
  public readonly name: string;

  public constructor(
    private readonly params: RcaIndicatorParams,
  ) {
    super();

    this.name = `rca${params.period}`;
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

    const previousWindowLast = params.reversedCandles[this.params.period];

    if (!previousWindowLast) {
      return this.initialize(params);
    }

    const sum = state.sum + latest.close - previousWindowLast.close;
    const value = sum / this.params.period;

    this.stateByMarket.set(params.marketName, {
      value,
      sum,
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
      sum,
      lastReceivedAt: latest.receivedAt,
    });

    return value;
  }
}
