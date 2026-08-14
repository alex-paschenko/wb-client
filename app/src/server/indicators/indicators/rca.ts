// app/src/server/indicators/indicators/rca.ts

import type {
  MarketCandle,
} from '../../../shared/types/market-statistics-storage.js';
import type {
  MarketIndicatorCalculationParams,
} from '../../types/market-indicators.js';
import type {
  IndicatorAffectedRange,
} from '../base-indicator.js';
import { IncrementalIndicator } from '../incremental-indicator.js';

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
    requiresRemovedValues: false,
  } as const;

  private readonly period: number;

  public constructor(params: RcaIndicatorParams) {
    super(params.period);

    this.period = params.period;
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
      const relativeSpeed = this.calculateRelativeSpeed(
        candles[index + 1],
        candles[index],
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

    if (!state || candles.length < this.period + 2) {
      return this.fullCalculate(params);
    }

    const newestCandle = candles[0];
    const previousNewestCandle = candles[1];
    const expiredCurrentCandle = candles[this.period];
    const expiredPreviousCandle = candles[this.period + 1];

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
  ): void {
    const values = this.getAscendingValues(params);

    for (const range of affectedRanges) {
      const finalRelativeSpeedSum =
        this.calculateRange(params, range, values);

      if (range.endIndexAsc !== values.length - 1) {
        continue;
      }

      if (finalRelativeSpeedSum === null) {
        this.stateByMarket.delete(params.marketName);
      } else {
        this.stateByMarket.set(params.marketName, {
          relativeSpeedSum: finalRelativeSpeedSum,
        });
      }
    }
  }

  private calculateRange(
    params: MarketIndicatorCalculationParams,
    range: IndicatorAffectedRange,
    values: ReturnType<RcaIndicator['getAscendingValues']>,
  ): number | null {
    const candles = params.ascending.candles;

    const preloadStartIndex = Math.max(
      1,
      range.startIndexAsc - this.period + 1,
    );

    let relativeSpeedSum = 0;
    let invalidRelativeSpeedCount = 0;
    let finalRelativeSpeedSum: number | null = null;

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
        invalidRelativeSpeedCount > 0
      ) {
        values[index] = null;
        finalRelativeSpeedSum = null;
        continue;
      }

      const value = this.calculateValue(relativeSpeedSum);

      values[index] = value;
      finalRelativeSpeedSum = relativeSpeedSum;
    }

    return finalRelativeSpeedSum;
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
