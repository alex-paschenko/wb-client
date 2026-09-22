import type {
  IndicatorValue,
  MarketForecastValue,
  MarketPhaseValue,
} from '../../../shared/types/data-types.js';
import type { StorageAccessors } from '../../../shared/types/storage.js';
import type { EntityAffectedRange } from '../../types/entities.js';
import { BaseEntity } from '../base-entity.js';
import {
  MARKET_FORECAST_10S,
  MARKET_FORECAST_30S,
  MARKET_FORECAST_1M,
  MARKET_FORECAST_2M,
  MARKET_FORECAST_5M,
  MARKET_FORECAST_ALIGNED_SURPRISE_BOUNDARIES,
  MARKET_FORECAST_NORMALIZED_SPEED_BOUNDARIES,
  MARKET_FORECAST_RELATIVE_ACCELERATION_BOUNDARIES,
} from '../../constants/market-forecast-table.js';
import { buildPhaseIndicatorName } from '../../utilities/entity.js';
import { getMarketPhaseTau } from '../../utilities/time.js';
import { MINUTE } from '../../../shared/constants/time.js';

interface MarketForecastIndicatorParams {
  responseTime: number;
}

const EMPTY_VALUE: MarketForecastValue = {
  expectedReturn10s: null,
  expectedReturn30s: null,
  expectedReturn1m: null,
  expectedReturn2m: null,
  expectedReturn5m: null,
};

export class MarketForecastIndicator
  extends BaseEntity<MarketForecastValue> {
  private readonly phaseName: string;
  private readonly phaseTauMinutes: number;

  public constructor(params: MarketForecastIndicatorParams) {
    const phaseTau = getMarketPhaseTau(params.responseTime);
    const phaseName = buildPhaseIndicatorName(params.responseTime);

    super(
      {
        kind: 'indicators',
        name: 'market-forecast',
        codec: 'market forecast v1.0',
        data: [],
        requiresRemovedValues: false,
        empty: EMPTY_VALUE,
      },
      [phaseName],
    );

    if (!Number.isFinite(phaseTau) || phaseTau <= 0) {
      throw new Error(
        `Market forecast phaseTau must be a positive finite number: ${phaseTau}`,
      );
    }

    this.phaseName = phaseName;
    this.phaseTauMinutes = phaseTau / MINUTE;
  }

  public calculate(
    accessors: StorageAccessors,
    _marketName: string,
  ): void {
    const values = this.getValues(accessors);

    if (values.length === 0) {
      return;
    }

    const changedIntervals = this.getChangedIntervals(accessors);

    if (changedIntervals.length === 0) {
      return;
    }

    const affectedRanges = this.buildFiniteAffectedRanges(
      accessors,
      1,
      changedIntervals,
    );

    for (const range of affectedRanges) {
      this.calculateRange(accessors, range);
    }
  }

  private calculateRange(
    accessors: StorageAccessors,
    range: EntityAffectedRange,
  ): void {
    const phases = this.getEntityValues<MarketPhaseValue>(
      accessors,
      'indicators',
      this.phaseName,
    );

    const values = this.getValues(accessors);

    for (let index = range.startIndex; index <= range.endIndex; index++) {
      values.set(index, this.calculateValue(phases.get(index)));
    }
  }

  private calculateValue(
    phase: MarketPhaseValue,
  ): MarketForecastValue {
    const { speed, acceleration, surprise, residualVariance } = phase;

    if (
      !Number.isFinite(speed) ||
      speed === 0 ||
      !Number.isFinite(acceleration) ||
      !Number.isFinite(surprise) ||
      !Number.isFinite(residualVariance) ||
      residualVariance <= 0
    ) {
      return EMPTY_VALUE;
    }

    const residualDeviation = Math.sqrt(residualVariance);
    const direction = Math.sign(speed);

    const absoluteNormalizedSpeed =
      Math.abs(speed) * this.phaseTauMinutes / residualDeviation;

    const relativeAcceleration =
      acceleration * this.phaseTauMinutes / speed;

    const alignedSurprise = surprise * direction;

    const tableIndex = this.getTableIndex(
      absoluteNormalizedSpeed,
      relativeAcceleration,
      alignedSurprise,
    );

    return {
      expectedReturn10s: this.getExpectedReturn(
        MARKET_FORECAST_10S,
        tableIndex,
        direction,
      ),
      expectedReturn30s: this.getExpectedReturn(
        MARKET_FORECAST_30S,
        tableIndex,
        direction,
      ),
      expectedReturn1m: this.getExpectedReturn(
        MARKET_FORECAST_1M,
        tableIndex,
        direction,
      ),
      expectedReturn2m: this.getExpectedReturn(
        MARKET_FORECAST_2M,
        tableIndex,
        direction,
      ),
      expectedReturn5m: this.getExpectedReturn(
        MARKET_FORECAST_5M,
        tableIndex,
        direction,
      ),
    };
  }

  private getTableIndex(
    absoluteNormalizedSpeed: number,
    relativeAcceleration: number,
    alignedSurprise: number,
  ): number {
    const speedIndex = this.getBinIndex(
      absoluteNormalizedSpeed,
      MARKET_FORECAST_NORMALIZED_SPEED_BOUNDARIES,
    );

    const accelerationIndex = this.getBinIndex(
      relativeAcceleration,
      MARKET_FORECAST_RELATIVE_ACCELERATION_BOUNDARIES,
    );

    const surpriseIndex = this.getBinIndex(
      alignedSurprise,
      MARKET_FORECAST_ALIGNED_SURPRISE_BOUNDARIES,
    );

    const accelerationCount =
      MARKET_FORECAST_RELATIVE_ACCELERATION_BOUNDARIES.length + 1;

    const surpriseCount =
      MARKET_FORECAST_ALIGNED_SURPRISE_BOUNDARIES.length + 1;

    return (
      (speedIndex * accelerationCount + accelerationIndex) *
      surpriseCount +
      surpriseIndex
    );
  }

  private getBinIndex(
    value: number,
    boundaries: readonly number[],
  ): number {
    for (let index = 0; index < boundaries.length; index++) {
      if (value < boundaries[index]) {
        return index;
      }
    }

    return boundaries.length;
  }

  private getExpectedReturn(
    table: Float64Array,
    index: number,
    direction: number,
  ): IndicatorValue {
    const alignedReturn = table[index];

    return Number.isFinite(alignedReturn)
      ? alignedReturn * direction
      : null;
  }
}
