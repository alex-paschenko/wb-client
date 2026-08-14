// app/src/server/indicators/indicators/continuous-ema.ts

import type {
  MarketCandle,
} from '../../../shared/types/market-statistics-storage.js';
import { convertIntervalToTimeWithUnit } from '../../../shared/utilities/time.js';
import {
  RecursiveFilterIndicator,
} from '../recursive-filter-indicator.js';

interface ContinuousEmaIndicatorParams {
  tau: number;
}

export class ContinuousEmaIndicator
  extends RecursiveFilterIndicator {
  public readonly name: string;

  public constructor(
    params: ContinuousEmaIndicatorParams,
  ) {
    super(params.tau);
    const { count, abbreviation} =
      convertIntervalToTimeWithUnit(params.tau);
    this.name = `continuous-ema-${count}${abbreviation}`;
  }

  protected getInput(
    candle: MarketCandle,
  ): number | null {
    return Number.isFinite(candle.speed)
      ? candle.speed
      : null;
  }
}
