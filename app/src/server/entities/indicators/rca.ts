// app/src/server/entities/indicators/rca.ts

import { CANDLE_NAME } from '../../../shared/constants/storage-entities.js';
import type { MarketCandle } from '../../../shared/types/data-types.js';
import type { StorageAccessors } from '../../../shared/types/storage.js';
import type { EntityAffectedRange } from '../../types/entities.js';
import { IncrementalIndicator } from './incremental-indicator.js';

interface RcaIndicatorParams {
  period: number;
}

interface RcaIndicatorState {
  relativeSpeedSum: number;
}

export class RcaIndicator
extends IncrementalIndicator<RcaIndicatorState> {
  protected readonly infiniteRange = false;

  private readonly period: number;

  public constructor(params: RcaIndicatorParams) {
    super(
      params.period,
      {
        kind: 'indicators',
        name: `rca-${params.period}`,
        codec: 'float32 (nullable) v1.0',
        group: 'rca',
        dataKind: ['line'],
        requiresRemovedValues: false,
        empty: null,
      },
    );

    this.period = params.period;
  }

  protected fullCalculate(
    accessors: StorageAccessors,
    marketName: string,
  ): number | null {
    const candles = this.getCandles(accessors);

    if (candles.length < this.period + 1) {
      this.stateByMarket.delete(marketName);
      return null;
    }

    let relativeSpeedSum = 0;

    for (let index = candles.length - this.period; index < candles.length; index++) {
      const relativeSpeed = this.calculateRelativeSpeed(
        candles,
        index - 1,
        index,
      );

      if (relativeSpeed === null) {
        this.stateByMarket.delete(marketName);
        return null;
      }

      relativeSpeedSum += relativeSpeed;
    }

    this.stateByMarket.set(marketName, { relativeSpeedSum });

    return this.calculateValue(relativeSpeedSum);
  }

  protected incrementalCalculate(
    accessors: StorageAccessors,
    marketName: string,
  ): number | null {
    const state = this.stateByMarket.get(marketName);
    const candles = this.getCandles(accessors);

    if (!state || candles.length < this.period + 2) {
      return this.fullCalculate(accessors, marketName);
    }

    const newestIndex = candles.length - 1;

    const addedRelativeSpeed = this.calculateRelativeSpeed(
      candles,
      newestIndex - 1,
      newestIndex,
    );

    const removedCurrentIndex = newestIndex - this.period;
    const removedRelativeSpeed = this.calculateRelativeSpeed(
      candles,
      removedCurrentIndex - 1,
      removedCurrentIndex,
    );

    if (addedRelativeSpeed === null || removedRelativeSpeed === null) {
      return this.fullCalculate(accessors, marketName);
    }

    const relativeSpeedSum =
      state.relativeSpeedSum -
      removedRelativeSpeed +
      addedRelativeSpeed;

    this.stateByMarket.set(marketName, { relativeSpeedSum });

    return this.calculateValue(relativeSpeedSum);
  }

  protected rangeCalculate(
    accessors: StorageAccessors,
    marketName: string,
    affectedRanges: EntityAffectedRange[],
  ): void {
    const values = this.getValues(accessors);

    for (const range of affectedRanges) {
      const finalRelativeSpeedSum =
        this.calculateRange(accessors, range);

      if (range.endIndex !== values.length - 1) {
        continue;
      }

      if (finalRelativeSpeedSum === null) {
        this.stateByMarket.delete(marketName);
      } else {
        this.stateByMarket.set(marketName, {
          relativeSpeedSum: finalRelativeSpeedSum,
        });
      }
    }
  }

  private calculateRange(
    accessors: StorageAccessors,
    range: EntityAffectedRange,
  ): number | null {
    const candles = this.getCandles(accessors);
    const values = this.getValues(accessors);

    const preloadStartIndex = Math.max(
      1,
      range.startIndex - this.period + 1,
    );

    let relativeSpeedSum = 0;
    let invalidRelativeSpeedCount = 0;
    let finalRelativeSpeedSum: number | null = null;

    const addRelativeSpeed = (currentIndex: number): void => {
      const relativeSpeed = this.calculateRelativeSpeed(
        candles,
        currentIndex - 1,
        currentIndex,
      );

      if (relativeSpeed === null) {
        invalidRelativeSpeedCount++;
        return;
      }

      relativeSpeedSum += relativeSpeed;
    };

    const removeRelativeSpeed = (currentIndex: number): void => {
      const relativeSpeed = this.calculateRelativeSpeed(
        candles,
        currentIndex - 1,
        currentIndex,
      );

      if (relativeSpeed === null) {
        invalidRelativeSpeedCount--;
        return;
      }

      relativeSpeedSum -= relativeSpeed;
    };

    for (let index = preloadStartIndex; index < range.startIndex; index++) {
      addRelativeSpeed(index);
    }

    for (let index = range.startIndex; index <= range.endIndex; index++) {
      if (index > 0) {
        addRelativeSpeed(index);
      }

      const expiredRelativeSpeedIndex = index - this.period;

      if (expiredRelativeSpeedIndex >= preloadStartIndex) {
        removeRelativeSpeed(expiredRelativeSpeedIndex);
      }

      const oldestIndex = index - this.period;

      if (oldestIndex < 0 || invalidRelativeSpeedCount > 0) {
        values.set(index, null);
        finalRelativeSpeedSum = null;
        continue;
      }

      const value = this.calculateValue(relativeSpeedSum);

      values.set(index, value);
      finalRelativeSpeedSum = relativeSpeedSum;
    }

    return finalRelativeSpeedSum;
  }

  private calculateRelativeSpeed(
    candles: ReturnType<RcaIndicator['getCandles']>,
    previousIndex: number,
    currentIndex: number,
  ): number | null {
    if (previousIndex < 0 || currentIndex >= candles.length) {
      return null;
    }

    const previousClose = candles.get(previousIndex, 'close');
    const currentSpeed = candles.get(currentIndex, 'speed');

    if (
      previousClose === 0 ||
      !Number.isFinite(previousClose) ||
      !Number.isFinite(currentSpeed)
    ) {
      return null;
    }

    return currentSpeed / previousClose;
  }

  private getCandles(
    accessors: StorageAccessors,
  ) {
    return this.getEntityValues<MarketCandle>(accessors, CANDLE_NAME);
  }

  private calculateValue(relativeSpeedSum: number): number {
    return relativeSpeedSum * 100_000 / this.period;
  }
}
