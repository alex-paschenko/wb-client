// app/src/server/indicators/indicators/rca.ts

import type {
  MarketIndicatorRecalculatedItem,
} from '../../../shared/types/market-indicators.js';
import type {
  MarketCandle,
} from '../../../shared/types/market-statistics-storage.js';
import type {
  MarketIndicatorCalculationParams,
} from '../../types/market-indicators.js';
import type {
  IndicatorAffectedRange,
} from '../base-indicator.js';
import {
  IncrementalIndicator,
} from '../incremental-indicator.js';

interface RcaIndicatorParams {
  period: number;
}

interface RcaIndicatorState {
  relativeSpeedSum: number;
}

export class RcaIndicator extends IncrementalIndicator<RcaIndicatorState> {
  public readonly name: string;

  protected readonly infiniteRange = false;

  protected readonly definition = {
    codec: 'float32',
    group: 'rca',
  } as const;

  public constructor(params: RcaIndicatorParams) {
    super(params.period);

    this.name = `rca-${params.period}`;
  }

  protected fullCalculate(
    params: MarketIndicatorCalculationParams,
  ): number | null {
    const candles = params.descending.candles;

    if (candles.length < this.period + 1) {
      this.stateByMarket.delete(params.marketName);
      return null;
    }

    let relativeSpeedSum = 0;

    for (let index = 0; index < this.period; index += 1) {
      const currentCandle = candles[index];
      const previousCandle = candles[index + 1];

      const relativeSpeed = this.calculateRelativeSpeed(
        previousCandle,
        currentCandle,
      );

      if (relativeSpeed === null) {
        this.stateByMarket.delete(params.marketName);
        return null;
      }

      relativeSpeedSum += relativeSpeed;
    }

    this.stateByMarket.set(params.marketName, {
      relativeSpeedSum,
    });

    return this.calculateValue(relativeSpeedSum);
  }

  protected incrementalCalculate(
    params: MarketIndicatorCalculationParams,
  ): number | null {
    const state = this.stateByMarket.get(params.marketName);
    const candles = params.descending.candles;

    const newestCandle = candles[0];
    const previousNewestCandle = candles[1];
    const expiredCurrentCandle = candles[this.period];
    const expiredPreviousCandle = candles[this.period + 1];

    if (
      !state ||
      !newestCandle ||
      !previousNewestCandle ||
      !expiredCurrentCandle ||
      !expiredPreviousCandle
    ) {
      return this.fullCalculate(params);
    }

    const addedRelativeSpeed = this.calculateRelativeSpeed(
      previousNewestCandle,
      newestCandle,
    );

    const removedRelativeSpeed = this.calculateRelativeSpeed(
      expiredPreviousCandle,
      expiredCurrentCandle,
    );

    if (addedRelativeSpeed === null || removedRelativeSpeed === null) {
      return this.fullCalculate(params);
    }

    const relativeSpeedSum =
      state.relativeSpeedSum -
      removedRelativeSpeed +
      addedRelativeSpeed;

    this.stateByMarket.set(params.marketName, {
      relativeSpeedSum,
    });

    return this.calculateValue(relativeSpeedSum);
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
    const candles = params.ascending.candles;
    const values: (number | null)[] = [];

    const preloadStartIndex = Math.max(
      1,
      range.startIndexAsc - this.period + 1,
    );

    let relativeSpeedSum = 0;
    let invalidRelativeSpeedCount = 0;

    const addRelativeSpeed = (currentIndex: number): void => {
      const relativeSpeed = this.calculateRelativeSpeed(
        candles[currentIndex - 1],
        candles[currentIndex],
      );

      if (relativeSpeed === null) {
        invalidRelativeSpeedCount += 1;
        return;
      }

      relativeSpeedSum += relativeSpeed;
    };

    const removeRelativeSpeed = (currentIndex: number): void => {
      const relativeSpeed = this.calculateRelativeSpeed(
        candles[currentIndex - 1],
        candles[currentIndex],
      );

      if (relativeSpeed === null) {
        invalidRelativeSpeedCount -= 1;
        return;
      }

      relativeSpeedSum -= relativeSpeed;
    };

    for (
      let index = preloadStartIndex;
      index < range.startIndexAsc;
      index += 1
    ) {
      addRelativeSpeed(index);
    }

    for (
      let index = range.startIndexAsc;
      index <= range.endIndexAsc;
      index += 1
    ) {
      if (index > 0) {
        addRelativeSpeed(index);
      }

      const expiredRelativeSpeedIndex = index - this.period;

      if (expiredRelativeSpeedIndex >= preloadStartIndex) {
        removeRelativeSpeed(expiredRelativeSpeedIndex);
      }

      const oldestIndex = index - this.period;

      if (
        oldestIndex < 0 ||
        invalidRelativeSpeedCount > 0 ||
        !candles[oldestIndex] ||
        !candles[index]
      ) {
        values.push(null);
        continue;
      }

      values.push(this.calculateValue(relativeSpeedSum));
    }

    return values;
  }

  private calculateRelativeSpeed(
    previousCandle: MarketCandle | undefined,
    currentCandle: MarketCandle | undefined,
  ): number | null {
    if (!previousCandle || !currentCandle) {
      return null;
    }

    if (
      previousCandle.close === 0 ||
      !Number.isFinite(previousCandle.close) ||
      !Number.isFinite(currentCandle.speed)
    ) {
      return null;
    }

    return currentCandle.speed / previousCandle.close;
  }

  private calculateValue(relativeSpeedSum: number): number {
    return relativeSpeedSum * 100_000 / this.period;
  }
}
