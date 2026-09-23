// app/src/server/entities/candles/candle.ts

import { CANDLE_NAME } from '../../../shared/constants/storage-entities.js';
import type { MarketCandle } from '../../../shared/types/data-types.js';
import type {
  LazyArrayDeletedItems,
} from '../../../shared/types/lazy-array.js';
import type { StorageAccessors } from '../../../shared/types/storage.js';
import { calculateTimeDerivative } from '../../utilities/derivative-integral.js';
import { calculateSpeed } from '../../utilities/price.js';
import { BaseEntity } from '../base-entity.js';

export class CandleEntity extends BaseEntity<MarketCandle> {
  public constructor() {
    super({
      kind: 'candles',
      name: CANDLE_NAME,
      codec: 'candle v1.0',
      data: [
        { kind: 'ohlc', group: 'candles' },
        { kind: 'line', group: 'candles', key: 'price', style: 'price' },
        { kind: 'line', group: 'speed', key: 'speed' },
        { kind: 'line', group: 'speed', key: 'acceleration' },
      ],
      requiresRemovedValues: true,
      empty: {
        receivedAt: 0,
        price: 0,
        speed: 0,
        acceleration: 0,
        startedAt: 0,
        endedAt: 0,
        open: 0,
        close: 0,
        high: 0,
        low: 0,
      },
    });
  }

  public calculate(
    accessors: StorageAccessors,
    _marketName: string,
  ): void {
    const candles = this.getValues(accessors);
    const deletedItems = candles.getDeleted();
    const ranges = this.buildFiniteAffectedRanges(accessors, 1);

    for (const range of ranges) {
      for (let index = range.startIndex; index <= range.endIndex; index++) {
        const candle = candles.get(index);
        const previous = index > 0 ? candles.get(index - 1) : undefined;

        const deleted = this.getDeletedItems(deletedItems, index);

        const price = deleted
          ? this.calculateAggregatedPrice(deleted.values, previous)
          : candle.price;


        const speed = calculateSpeed(
          previous?.receivedAt,
          previous?.price,
          candle.receivedAt,
          price,
        );

        const acceleration = calculateTimeDerivative(
          previous?.receivedAt,
          previous?.speed,
          candle.receivedAt,
          speed,
        );

        if (deleted) {
          candles.set(index, 'price', price);
        }

        candles.set(index, 'speed', speed);
        candles.set(index, 'acceleration', acceleration);
      }
    }
  }

  private getDeletedItems(
    deletedItems: readonly LazyArrayDeletedItems<MarketCandle>[],
    index: number,
  ): LazyArrayDeletedItems<MarketCandle> | undefined {
    return deletedItems.find((deleted) => deleted.index === index);
  }

  private calculateAggregatedPrice(
    candles: readonly MarketCandle[],
    previousCandle: MarketCandle | undefined,
  ): number {
    if (candles.length === 0) {
      throw new Error('Cannot calculate price from empty deleted items');
    }

    if (candles.length === 1) {
      return candles[0].price;
    }

    const first = candles[0];
    const firstInterval = candles[1].receivedAt - first.receivedAt;

    let previousReceivedAt =
      previousCandle?.receivedAt ?? first.receivedAt - firstInterval;

    let weightedPrice = 0;
    let summaryInterval = 0;

    for (const candle of candles) {
      const interval = candle.receivedAt - previousReceivedAt;

      weightedPrice += candle.price * interval;
      summaryInterval += interval;

      previousReceivedAt = candle.receivedAt;
    }

    return weightedPrice / summaryInterval;
  }
}

export const candle = new CandleEntity();
