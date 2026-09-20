// app/src/server/entities/indicators/market-phase.ts

import { CANDLE_NAME } from '../../../shared/constants/storage-entities.js';
import {
  RELATIVE_SPEED_SCALE,
  TIME_DERIVATIVE_SCALE,
} from '../../../shared/constants/time-derivatives.js';
import type {
  MarketCandle,
  MarketPhaseValue,
} from '../../../shared/types/data-types.js';
import type { StorageAccessors } from '../../../shared/types/storage.js';
import { convertIntervalToTimeWithUnit } from '../../../shared/utilities/time.js';
import { BaseEntity } from '../base-entity.js';

interface MarketPhaseIndicatorParams {
  tau: number;
}

interface ObserverGains {
  position: number;
  speed: number;
  acceleration: number;
}

const DAMPING = 0.7;
const DAMPED_FREQUENCY =
  Math.sqrt(1 - DAMPING * DAMPING);

const POSITION_SCALE =
  RELATIVE_SPEED_SCALE / TIME_DERIVATIVE_SCALE;

const SMALL_NORMALIZED_INTERVAL = 1e-3;

export class MarketPhaseIndicator
extends BaseEntity<MarketPhaseValue> {
  private readonly tau: number;

  public constructor(
    params: MarketPhaseIndicatorParams,
  ) {
    const { tau } = params;

    if (!Number.isFinite(tau) || tau <= 0) {
      throw new Error(
        `Market phase tau must be a positive finite number: ${tau}`,
      );
    }

    const { count, abbreviation } =
      convertIntervalToTimeWithUnit(tau);

    super({
      kind: 'indicators',
      name: `phase-${count}${abbreviation}`,
      codec: 'market phase v1.0',
      data: [
        {
          kind: 'line',
          group: 'marketPhase2',
          key: 'position',
        },
        {
          kind: 'speedLine',
          group: 'marketPhase',
          key: 'speed',
        },
        {
          kind: 'accelerationLine',
          group: 'marketPhase',
          key: 'acceleration',
        },
      ],
      requiresRemovedValues: false,
      empty: {
        position: 0,
        speed: 0,
        acceleration: 0,
      },
    });

    this.tau = tau;
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

    const affectedRanges = this.buildInfiniteAffectedRanges(
      accessors,
      changedIntervals,
    );

    for (const range of affectedRanges) {
      this.calculateRange(
        accessors,
        range.startIndex,
        range.endIndex,
      );
    }
  }

  private calculateRange(
    accessors: StorageAccessors,
    startIndex: number,
    endIndex: number,
  ): void {
    const candles = this.getCandles(accessors);
    const values = this.getValues(accessors);

    let previousValue: MarketPhaseValue | null =
      startIndex > 0
        ? values.get(startIndex - 1)
        : null;

    let previousReceivedAt: number | null =
      startIndex > 0
        ? candles.get(startIndex - 1, 'receivedAt')
        : null;

    for (let index = startIndex; index <= endIndex; index++) {
      const candle = candles.get(index);

      const value = this.calculateNextValue(
        previousValue,
        previousReceivedAt,
        candle,
      );

      values.set(index, value);

      previousValue = value;
      previousReceivedAt = candle.receivedAt;
    }
  }

  private calculateNextValue(
    previousValue: MarketPhaseValue | null,
    previousReceivedAt: number | null,
    candle: MarketCandle,
  ): MarketPhaseValue {
    const position = this.priceToPosition(candle.price);

    if (
      previousValue === null ||
      previousReceivedAt === null
    ) {
      return {
        position,
        speed: 0,
        acceleration: 0,
      };
    }

    const elapsed =
      candle.receivedAt - previousReceivedAt;

    if (elapsed < 0) {
      throw new Error(
        'Market phase candles must be ordered by receivedAt',
      );
    }

    if (elapsed === 0) {
      return previousValue;
    }

    const dt =
      elapsed / TIME_DERIVATIVE_SCALE;

    const tau =
      this.tau / TIME_DERIVATIVE_SCALE;

    const predictedPosition =
      previousValue.position +
      previousValue.speed * dt +
      0.5 * previousValue.acceleration * dt * dt;

    const predictedSpeed =
      previousValue.speed +
      previousValue.acceleration * dt;

    const residual =
      position - predictedPosition;

    const gains =
      this.getObserverGains(dt, tau);

    return {
      position:
        predictedPosition +
        gains.position * residual,

      speed:
        predictedSpeed +
        gains.speed * residual,

      acceleration:
        previousValue.acceleration +
        gains.acceleration * residual,
    };
  }

  private priceToPosition(price: number): number {
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(
        `Market phase price must be positive and finite: ${price}`,
      );
    }

    return POSITION_SCALE * Math.log(price);
  }

  private getObserverGains(
    dt: number,
    tau: number,
  ): ObserverGains {
    const x = dt / tau;

    if (x < SMALL_NORMALIZED_INTERVAL) {
      return this.getSmallIntervalObserverGains(x, dt);
    }

    const realPole =
      Math.exp(-x);

    const complexRadius =
      Math.exp(-DAMPING * x);

    const complexReal =
      complexRadius *
      Math.cos(DAMPED_FREQUENCY * x);

    const complexRadiusSquared =
      complexRadius * complexRadius;

    const s1 =
      realPole +
      2 * complexReal;

    const s2 =
      complexRadiusSquared +
      2 * realPole * complexReal;

    const s3 =
      realPole * complexRadiusSquared;

    return {
      position:
        1 - s3,

      speed:
        (-s1 - s2 + 3 * s3 + 3) /
        (2 * dt),

      acceleration:
        (-s1 + s2 - s3 + 1) /
        (dt * dt),
    };
  }

  private getSmallIntervalObserverGains(
    x: number,
    dt: number,
  ): ObserverGains {
    const position = x * (
      2.4 + x * (
        -2.88 + x * (
          2.304 + x * (
            -1.3824 + x * (
              0.663552 -
              0.2654208 * x
            )
          )
        )
      )
    );

    const speedNumerator = x * x * (
      2.4 + x * (
        -2.88 + x * (
          2.024 + x * (
            -1.0464 + x * (
              0.431865333333333 -
              0.1486768 * x
            )
          )
        )
      )
    );

    const accelerationNumerator = x * x * x * (
      1 + x * (
        -1.2 + x * (
          0.76 + x * (
            -0.336 +
            0.116346666666667 * x
          )
        )
      )
    );

    return {
      position,
      speed:
        speedNumerator / dt,
      acceleration:
        accelerationNumerator / (dt * dt),
    };
  }

  private getCandles(
    accessors: StorageAccessors,
  ) {
    return this.getEntityValues<MarketCandle>(
      accessors,
      'candles',
      CANDLE_NAME,
    );
  }
}
