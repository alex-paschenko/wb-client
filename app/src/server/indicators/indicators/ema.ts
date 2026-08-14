// app/src/server/indicators/indicators/ema.ts
import type {
  MarketIndicatorCalculationParams,
} from '../../types/market-indicators.js';
import type {
  IndicatorAffectedRange,
} from '../base-indicator.js';
import { IncrementalIndicator } from '../incremental-indicator.js';

interface EmaIndicatorParams {
  period: number;
}

interface EmaIndicatorState {
  value: number;
}

export class EmaIndicator extends IncrementalIndicator<EmaIndicatorState> {
  public readonly name: string;

  protected readonly infiniteRange = true;

  protected readonly definition = {
    codec: 'float32',
    group: 'price',
    requiresRemovedValues: false,
  } as const;

  public constructor(params: EmaIndicatorParams) {
    super(params.period);
    this.name = `ema-${params.period}`;
  }

  protected fullCalculate(
    params: MarketIndicatorCalculationParams,
  ): number | null {
    if (params.descending.candles.length < this.affectedValuesCount) {
      return null;
    }

    const value = this.calculateSeedAt(
      params,
      params.ascending.candles.length - 1,
    );

    if (value === null) {
      return null;
    }

    this.stateByMarket.set(params.marketName, { value });

    return value;
  }

  protected incrementalCalculate(
    params: MarketIndicatorCalculationParams,
  ): number | null {
    const state = this.stateByMarket.get(params.marketName);
    const candles = params.descending.candles;

    if (!state || candles.length === 0) {
      return this.fullCalculate(params);
    }

    const newestCandle = candles[0];
    const alpha = this.getAlpha();

    const value =
      state.value + alpha * (newestCandle.close - state.value);

    this.stateByMarket.set(params.marketName, { value });

    return value;
  }

  public rangeCalculate(
    params: MarketIndicatorCalculationParams,
    affectedRanges: IndicatorAffectedRange[],
  ): void {
    const values = this.getAscendingValues(params);

    for (const range of affectedRanges) {
      const lastValue = this.calculateRange(params, range, values);

      if (range.endIndexAsc !== values.length - 1) {
        continue;
      }

      if (lastValue === null) {
        this.stateByMarket.delete(params.marketName);
      } else {
        this.stateByMarket.set(params.marketName, {
          value: lastValue,
        });
      }
    }
  }

  private calculateRange(
    params: MarketIndicatorCalculationParams,
    range: IndicatorAffectedRange,
    values: ReturnType<EmaIndicator['getAscendingValues']>,
  ): number | null {
    const candles = params.ascending.candles;
    const alpha = this.getAlpha();

    let previousValue =
      this.getPreviousStoredValue(params, range.startIndexAsc);

    for (
      let index = range.startIndexAsc;
      index <= range.endIndexAsc;
      index += 1
    ) {
      const candle = candles[index];

      if (previousValue === null) {
        previousValue = this.calculateSeedAt(params, index);
        values[index] = previousValue;
        continue;
      }

      const value =
        previousValue + alpha * (candle.close - previousValue);

      values[index] = value;
      previousValue = value;
    }

    return previousValue;
  }

  private getPreviousStoredValue(
    params: MarketIndicatorCalculationParams,
    startIndexAsc: number,
  ): number | null {
    if (startIndexAsc <= 0) {
      return null;
    }

    return this.getAscendingValues(params)[startIndexAsc - 1] ?? null;
  }

  private calculateSeedAt(
    params: MarketIndicatorCalculationParams,
    indexAsc: number,
  ): number | null {
    const firstIndexAsc = indexAsc - this.affectedValuesCount + 1;

    if (firstIndexAsc < 0) {
      return null;
    }

    let sum = 0;

    for (let index = firstIndexAsc; index <= indexAsc; index += 1) {
      sum += params.ascending.candles[index].close;
    }

    return sum / this.affectedValuesCount;
  }

  private getAlpha(): number {
    return 2 / (this.affectedValuesCount + 1);
  }
}
