import { MINUTE, SECONDS } from '../../../shared/constants/time.js';
import {
  CANDLE_NAME,
  MARKET_FORECAST_NAME,
} from '../../../shared/constants/storage-entities.js';
import type {
  IndicatorValue,
  MarketCandle,
  MarketForecastValue,
} from '../../../shared/types/data-types.js';
import type { StorageAccessors } from '../../../shared/types/storage.js';
import {
  MARKET_FORECAST_3_EMA,
  MARKET_FORECAST_4_EMA,
  MARKET_FORECAST_ALIGNED_BINS,
  MARKET_FORECAST_SLOW_BINS,
  MARKET_FORECAST_CURVATURE_BINS,
  MARKET_FORECAST_PAIR_BINS,
  MARKET_FORECAST_COMBINED_CORRECTION,
} from '../../constants/market-forecast-table.js';
import type { EntityAffectedRange } from '../../types/entities.js';
import { BaseEntity } from '../base-entity.js';
import { marketPriceEmaName } from './market-price-ema.js';

const TAUS = [7, 15, 30, 60].map((seconds) => seconds * SECONDS);
const DIRECT_WARMUP = 150 * SECONDS;
const DERIVED_WARMUP = 300 * SECONDS;

const EMPTY_VALUE: MarketForecastValue = {
  expectedResidual1m3Ema: null,
  expectedResidual1m4Ema: null,
  expectedResidual1mCombined: null,
};

function bin(value: number, boundaries: readonly number[]): number {
  for (let i = 0; i < boundaries.length; i++) {
    if (value < boundaries[i]) return i;
  }
  return boundaries.length;
}

function fromTable(
  cell: number,
  sign: number,
  table: Float64Array,
): IndicatorValue {
  const aligned = table[cell];
  return Number.isFinite(aligned) ? sign * aligned : null;
}

export class MarketForecastIndicator extends BaseEntity<MarketForecastValue> {
  public constructor() {
    super({
      kind: 'indicators',
      name: MARKET_FORECAST_NAME,
      codec: 'market forecast v2.0',
      data: [],
      requiresRemovedValues: false,
      empty: EMPTY_VALUE,
    }, TAUS.map((tau) => marketPriceEmaName('log-price', tau)));
  }

  public calculate(accessors: StorageAccessors, _marketName: string): void {
    const values = this.getValues(accessors);
    if (values.length === 0) return;
    const changes = this.getChangedIntervals(accessors);
    if (changes.length === 0) return;
    for (const range of this.buildFiniteAffectedRanges(accessors, 1, changes)) {
      this.calculateRange(accessors, range);
    }
  }

  private calculateRange(
    accessors: StorageAccessors,
    range: EntityAffectedRange,
  ): void {
    const candles = this.getEntityValues<MarketCandle>(
      accessors, 'candles', CANDLE_NAME);
    const emas = TAUS.map((tau) => this.getEntityValues<IndicatorValue>(
      accessors, 'indicators', marketPriceEmaName('log-price', tau)));
    const values = this.getValues(accessors);
    const first = candles.get(0, 'receivedAt');
    for (let i = range.startIndex; i <= range.endIndex; i++) {
      const candle = candles.get(i);
      if (!Number.isFinite(candle.price) || candle.price <= 0) {
        values.set(i, EMPTY_VALUE);
        continue;
      }
      const x = 1000 * Math.log(candle.price);
      const speeds = emas.map((ema, j) => {
        const smoothed = ema.get(i);
        return smoothed === null ? NaN :
          (x - smoothed) / (TAUS[j] / MINUTE);
      });
      values.set(i, this.predict(speeds, candle.receivedAt - first));
    }
  }

  private predict(v: readonly number[], age: number): MarketForecastValue {
    if (!v.slice(0, 3).every(Number.isFinite)) return EMPTY_VALUE;
    const [v7, v15, v30, v60] = v;
    let direct: IndicatorValue = null;
    let derived: IndicatorValue = null;

    if (age >= DIRECT_WARMUP && v30 !== 0) {
      const sign = Math.sign(v30);
      const cell = (bin(v7 * sign, MARKET_FORECAST_ALIGNED_BINS) *
        (MARKET_FORECAST_ALIGNED_BINS.length + 1) +
        bin(v15 * sign, MARKET_FORECAST_ALIGNED_BINS)) *
        (MARKET_FORECAST_SLOW_BINS.length + 1) +
        bin(Math.abs(v30), MARKET_FORECAST_SLOW_BINS);
      direct = fromTable(cell, sign, MARKET_FORECAST_3_EMA);
    }

    if (age >= DERIVED_WARMUP && Number.isFinite(v60) && v60 !== 0) {
      const sign = Math.sign(v60);
      const contrast = (v7 - v30) * sign;
      const shortSlope = (v7 - v15) / ((15 - 7) / 60);
      const longSlope = (v30 - v60) / ((60 - 30) / 60);
      const curvature = (shortSlope - longSlope) * sign;
      if (Number.isFinite(contrast) && Number.isFinite(curvature)) {
        const cell = (bin(contrast, MARKET_FORECAST_ALIGNED_BINS) *
          (MARKET_FORECAST_CURVATURE_BINS.length + 1) +
          bin(curvature, MARKET_FORECAST_CURVATURE_BINS)) *
          (MARKET_FORECAST_SLOW_BINS.length + 1) +
          bin(Math.abs(v60), MARKET_FORECAST_SLOW_BINS);
        derived = fromTable(cell, sign, MARKET_FORECAST_4_EMA);
      }
    }

    let combined: IndicatorValue = direct ?? derived;
    if (direct !== null && derived !== null) {
      const cell = bin(direct, MARKET_FORECAST_PAIR_BINS) *
        (MARKET_FORECAST_PAIR_BINS.length + 1) +
        bin(derived, MARKET_FORECAST_PAIR_BINS);
      combined = (direct + derived) / 2 +
        MARKET_FORECAST_COMBINED_CORRECTION[cell];
    }
    return {
      expectedResidual1m3Ema: direct,
      expectedResidual1m4Ema: derived,
      expectedResidual1mCombined: combined,
    };
  }
}
