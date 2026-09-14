// app/src/server/entities/indicators/continuous-ema.ts

import type { MarketCandle } from '../../../shared/types/data-types.js';
import { convertIntervalToTimeWithUnit } from '../../../shared/utilities/time.js';
import {
  RecursiveFilterIndicator,
} from './recursive-filter-indicator.js';

interface ContinuousEmaIndicatorParams {
  tau: number;
}

export class ContinuousEmaIndicator
  extends RecursiveFilterIndicator {
  public constructor(
    params: ContinuousEmaIndicatorParams,
  ) {
    const { count, abbreviation } =
      convertIntervalToTimeWithUnit(params.tau);

    super(
      params.tau,
      `continuous-ema-${count}${abbreviation}`,
    );
  }

  protected getInput(
    candle: MarketCandle,
  ): number | null {
    return Number.isFinite(candle.speed)
      ? candle.speed
      : null;
  }
}
