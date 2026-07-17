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

interface EmaIndicatorParams {
  period: number;
}

interface EmaIndicatorState {
  value: number;
}

export class EmaIndicator extends IncrementalIndicator<EmaIndicatorState> {
  public readonly name: string;

  protected readonly infiniteRange = true;

  protected readonly storage = {
    codec: 'float32',
  } as const;

  public constructor(
    params: EmaIndicatorParams,
  ) {
    super(params.period);

    this.name = `ema-${params.period}`;
  }

  protected fullCalculate(
    params: MarketIndicatorCalculationParams,
  ): number | null {
    if (params.descending.candles.length < this.period) {
      return null;
    }

    const value = this.calculateSeedAt(
      params,
      params.ascending.candles.length - 1,
    );

    if (value === null) {
      return null;
    }

    this.stateByMarket.set(params.marketName, {
      value,
    });

    return value;
  }

  protected incrementalCalculate(
    params: MarketIndicatorCalculationParams,
  ): number | null {
    const state = this.stateByMarket.get(params.marketName);
    const newestCandle = params.descending.candles[0];

    if (!state || !newestCandle) {
      return this.fullCalculate(params);
    }

    const alpha = this.getAlpha();
    const value =
      state.value + alpha * (newestCandle.close - state.value);

    this.stateByMarket.set(params.marketName, {
      value,
    });

    return value;
  }

  public rangeCalculate(
    params: MarketIndicatorCalculationParams,
    affectedRanges: IndicatorAffectedRange[],
  ): MarketIndicatorRecalculatedItem[] {
    const result: MarketIndicatorRecalculatedItem[] = [];

    for (const range of affectedRanges) {
      result.push({
        startIndexAsc: range.startIndexAsc,
        values: this.calculateRange(params, range),
      });
    }

    return result;
  }

  private calculateRange(
    params: MarketIndicatorCalculationParams,
    range: IndicatorAffectedRange,
  ): (number | null)[] {
    const values: (number | null)[] = [];
    const alpha = this.getAlpha();

    let previousValue =
      this.getPreviousStoredValue(params, range.startIndexAsc);

    for (
      let index = range.startIndexAsc;
      index <= range.endIndexAsc;
      index += 1
    ) {
      const candle = params.ascending.candles[index];

      if (!candle) {
        values.push(null);
        previousValue = null;
        continue;
      }

      if (previousValue === null) {
        previousValue = this.calculateSeedAt(params, index);
        values.push(previousValue);
        continue;
      }

      const value =
        previousValue + alpha * (candle.close - previousValue);

      values.push(value);
      previousValue = value;
    }

    return values;
  }

  private getPreviousStoredValue(
    params: MarketIndicatorCalculationParams,
    startIndexAsc: number,
  ): number | null {
    if (startIndexAsc <= 0) {
      return null;
    }

    return params.ascending.indicators[startIndexAsc - 1]?.[this.name] ?? null;
  }

  private calculateSeedAt(
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

    return sum / this.period;
  }

  private getAlpha(): number {
    return 2 / (this.period + 1);
  }
}
