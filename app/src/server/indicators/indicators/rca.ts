import type {
  MarketIndicatorRecalculatedItem,
} from '../../../shared/types/market-indicators.js';

import type {
  MarketIndicatorCalculationParams,
} from '../../types/market-indicators.js';

import {
  type IndicatorAffectedRange,
} from '../base-indicator.js';

import {
  IncrementalIndicator,
} from '../incremental-indicator.js';

interface RcaIndicatorParams {
  period: number;
}

interface RcaIndicatorState {
  sum: number;
}

export class RcaIndicator extends IncrementalIndicator<RcaIndicatorState> {
  public readonly name: string;

  protected readonly infiniteRange = false;

  protected readonly storage = {
    codec: 'float32',
  } as const;

  public constructor(
    params: RcaIndicatorParams,
  ) {
    super(params.period);

    this.name = `rca-${params.period}`;
  }

  protected fullCalculate(
    params: MarketIndicatorCalculationParams,
  ): number | null {
    if (params.descending.candles.length < this.period) {
      return null;
    }

    let sum = 0;

    for (let index = 0; index < this.period; index += 1) {
      const candle = params.descending.candles[index];

      if (!candle) {
        return null;
      }

      sum += candle.close;
    }

    this.stateByMarket.set(params.marketName, {
      sum,
    });

    return this.calculateValue(params, sum);
  }

  protected incrementalCalculate(
    params: MarketIndicatorCalculationParams,
  ): number | null {
    const state = this.stateByMarket.get(params.marketName);
    const newestCandle = params.descending.candles[0];
    const removedCandle = params.descending.candles[this.period];

    if (!state || !newestCandle || !removedCandle) {
      return this.fullCalculate(params);
    }

    const sum =
      state.sum +
      newestCandle.close -
      removedCandle.close;

    this.stateByMarket.set(params.marketName, {
      sum,
    });

    return this.calculateValue(params, sum);
  }

  public rangeCalculate(
    params: MarketIndicatorCalculationParams,
    affectedRanges: IndicatorAffectedRange[],
  ): MarketIndicatorRecalculatedItem[] {
    return affectedRanges.map((range) => ({
      startIndexAsc: range.startIndexAsc,
      values: this.calculateRange(params, range),
    }));
  }

  private calculateRange(
    params: MarketIndicatorCalculationParams,
    range: IndicatorAffectedRange,
  ): (number | null)[] {
    const values: (number | null)[] = [];

    for (
      let index = range.startIndexAsc;
      index <= range.endIndexAsc;
      index += 1
    ) {
      values.push(
        this.calculateValueAt(params, index),
      );
    }

    return values;
  }

  private calculateValueAt(
    params: MarketIndicatorCalculationParams,
    indexAsc: number,
  ): number | null {
    const firstIndexAsc = indexAsc - this.period + 1;

    if (firstIndexAsc < 0) {
      return null;
    }

    let sum = 0;

    for (let index = firstIndexAsc; index <= indexAsc; index += 1) {
      const candle = params.ascending.candles[index];

      if (!candle) {
        return null;
      }

      sum += candle.close;
    }

    const newestCandle = params.ascending.candles[indexAsc];
    const oldestCandle = params.ascending.candles[firstIndexAsc];

    if (!newestCandle || !oldestCandle) {
      return null;
    }

    const duration =
      newestCandle.receivedAt - oldestCandle.receivedAt;

    if (duration <= 0) {
      return null;
    }

    return sum / duration;
  }

  private calculateValue(
    params: MarketIndicatorCalculationParams,
    sum: number,
  ): number | null {
    const newestCandle = params.descending.candles[0];
    const oldestCandle =
      params.descending.candles[this.period - 1];

    if (!newestCandle || !oldestCandle) {
      return null;
    }

    const duration =
      newestCandle.receivedAt - oldestCandle.receivedAt;

    if (duration <= 0) {
      return null;
    }

    return sum / duration;
  }
}
