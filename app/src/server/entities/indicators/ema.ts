// app/src/server/entities/indicators/ema.ts

import { CANDLE_NAME } from '../../../shared/constants/storage-entities.js';
import type { MarketCandle } from '../../../shared/types/data-types.js';
import type { StorageAccessors } from '../../../shared/types/storage.js';
import type { EntityAffectedRange } from '../../types/entities.js';
import { IncrementalIndicator } from './incremental-indicator.js';

interface EmaIndicatorParams {
  period: number;
}

interface EmaIndicatorState {
  value: number;
}

export class EmaIndicator
extends IncrementalIndicator<EmaIndicatorState> {
  protected readonly infiniteRange = true;

  public constructor(params: EmaIndicatorParams) {
    super(
      params.period,
      {
        kind: 'indicators',
        name: `ema-${params.period}`,
        codec: 'float32 (nullable) v1.0',
        group: 'price',
        dataKind: ['line'],
        requiresRemovedValues: false,
        empty: null,
      },
    );
  }

  protected fullCalculate(
    accessors: StorageAccessors,
    marketName: string,
  ): number | null {
    const candles = this.getCandles(accessors);

    if (candles.length < this.affectedValuesCount) {
      return null;
    }

    const value = this.calculateSeedAt(accessors, candles.length - 1);

    if (value === null) {
      return null;
    }

    this.stateByMarket.set(marketName, { value });

    return value;
  }

  protected incrementalCalculate(
    accessors: StorageAccessors,
     marketName: string,
  ): number | null {
    const state = this.stateByMarket.get(marketName);
    const candles = this.getCandles(accessors);

    if (!state || candles.length === 0) {
      return this.fullCalculate(accessors, marketName);
    }

    const newestCandle = candles.get(candles.length - 1);
    const alpha = this.getAlpha();

    const value = state.value + alpha * (newestCandle.close - state.value);

    this.stateByMarket.set(marketName, { value });

    return value;
  }

  protected rangeCalculate(
    accessors: StorageAccessors,
    marketName: string,
    affectedRanges: EntityAffectedRange[],
  ): void {
    const values = this.getValues(accessors);

    for (const range of affectedRanges) {
      const lastValue = this.calculateRange(accessors, range);

      if (range.endIndex !== values.length - 1) {
        continue;
      }

      if (lastValue === null) {
        this.stateByMarket.delete(marketName);
      } else {
        this.stateByMarket.set(marketName, { value: lastValue });
      }
    }
  }

  private calculateRange(
    accessors: StorageAccessors,
    range: EntityAffectedRange,
  ): number | null {
    const candles = this.getCandles(accessors);
    const values = this.getValues(accessors);
    const alpha = this.getAlpha();

    let previousValue =
      this.getPreviousStoredValue(accessors, range.startIndex);

    for (let index = range.startIndex; index <= range.endIndex; index++) {
      const candle = candles.get(index);

      if (previousValue === null) {
        previousValue = this.calculateSeedAt(accessors, index);
        values.set(index, previousValue);
        continue;
      }

      const value =
        previousValue + alpha * (candle.close - previousValue);

      values.set(index, value);
      previousValue = value;
    }

    return previousValue;
  }

  private getPreviousStoredValue(
    accessors: StorageAccessors,
    startIndex: number,
  ): number | null {
    if (startIndex <= 0) {
      return null;
    }

    return this.getValues(accessors).get(startIndex - 1) ?? null;
  }

  private calculateSeedAt(
    accessors: StorageAccessors,
    index: number,
  ): number | null {
    const firstIndex = index - this.affectedValuesCount + 1;

    if (firstIndex < 0) {
      return null;
    }

    const candles = this.getCandles(accessors);

    let sum = 0;

    for (let currentIndex = firstIndex; currentIndex <= index; currentIndex++) {
      sum += candles.get(currentIndex, 'close');
    }

    return sum / this.affectedValuesCount;
  }

  private getCandles(
    accessors: StorageAccessors,
  ) {
    return this.getEntityValues<MarketCandle>(accessors, CANDLE_NAME);
  }

  private getAlpha(): number {
    return 2 / (this.affectedValuesCount + 1);
  }
}
