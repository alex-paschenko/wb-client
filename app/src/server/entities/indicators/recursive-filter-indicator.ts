// app/src/server/entities/indicators/recursive-filter-indicator.ts

import { CANDLE_NAME } from '../../../shared/constants/storage-entities.js';
import type {
  IndicatorValue,
  MarketCandle,
} from '../../../shared/types/data-types.js';
import type { StorageAccessors } from '../../../shared/types/storage.js';
import type { EntityAffectedRange } from '../../types/entities.js';
import { IncrementalIndicator } from './incremental-indicator.js';

interface RecursiveFilterState {
  value: number;
  receivedAt: number;
}

export abstract class RecursiveFilterIndicator
extends IncrementalIndicator<RecursiveFilterState> {
  protected readonly infiniteRange = true;

  protected constructor(
    protected readonly tau: number,
    name: string,
  ) {
    super(
      0,
      {
        kind: 'indicators',
        name,
        codec: 'float32 (nullable) v1.0',
        data: [{ kind: 'line', group: 'recursiveFilter' }],
        requiresRemovedValues: true,
        empty: null,
      },
    );

    if (!Number.isFinite(tau) || tau <= 0) {
      throw new Error(
        `Indicator tau must be a positive finite number: ${tau}`,
      );
    }
  }

  protected fullCalculate(
    accessors: StorageAccessors,
    marketName: string,
  ): number | null {
    let previousValue: IndicatorValue = null;
    let previousReceivedAt: number | null = null;

    const candles = this.getCandles(accessors);
    const values = this.getValues(accessors);

    for (let index = 0; index < candles.length; index++) {
      const candle = candles.get(index);
      const storedValue = values.get(index);

      if (
        typeof storedValue === 'number' &&
        Number.isFinite(storedValue)
      ) {
        previousValue = storedValue;
        previousReceivedAt = candle.receivedAt;
        continue;
      }

      previousValue = this.calculateNextValue(
        previousValue,
        previousReceivedAt,
        candle,
      );

      previousReceivedAt = candle.receivedAt;
    }

    this.updateState(marketName, previousValue, previousReceivedAt);

    return previousValue;
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

    if (newestCandle.receivedAt <= state.receivedAt) {
      return state.value;
    }

    const value = this.calculateNextValue(
      state.value,
      state.receivedAt,
      newestCandle,
    );

    this.updateState(marketName, value, newestCandle.receivedAt);

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

      const candle = this.getCandles(accessors).get(range.endIndex);

      this.updateState(marketName, lastValue, candle.receivedAt);
    }
  }

  protected abstract getInput(candle: MarketCandle): number | null;

  protected getEffectiveTau(_candle: MarketCandle): number {
    return this.tau;
  }

  private calculateRange(
    accessors: StorageAccessors,
    range: EntityAffectedRange,
  ): IndicatorValue {
    const candles = this.getCandles(accessors);
    const values = this.getValues(accessors);

    const deletedByIndex = new Map(
      values.getDeleted().map((deleted) => [
        deleted.index,
        deleted.values.at(-1) ?? null,
      ]),
    );

    let previousValue: IndicatorValue =
      range.startIndex > 0
        ? values.get(range.startIndex - 1)
        : null;

    let previousReceivedAt: number | null =
      range.startIndex > 0
        ? candles.get(range.startIndex - 1, 'receivedAt')
        : null;

    for (let index = range.startIndex; index <= range.endIndex; index++) {
      const candle = candles.get(index);
      const deletedValue = deletedByIndex.get(index);

      if (deletedValue !== undefined) {
        previousValue = deletedValue;
        previousReceivedAt = candle.receivedAt;
        values.set(index, previousValue);
        continue;
      }

      previousValue = this.calculateNextValue(
        previousValue,
        previousReceivedAt,
        candle,
      );

      previousReceivedAt = candle.receivedAt;
      values.set(index, previousValue);
    }

    return previousValue;
  }

  private getCandles(
    accessors: StorageAccessors,
  ) {
    return this.getEntityValues<MarketCandle>(accessors, 'candles', CANDLE_NAME);
  }

  private calculateNextValue(
    previousValue: IndicatorValue,
    previousReceivedAt: number | null,
    candle: MarketCandle,
  ): IndicatorValue {
    const input = this.getInput(candle);

    if (input === null || !Number.isFinite(input)) {
      return null;
    }

    if (previousValue === null || previousReceivedAt === null) {
      return input;
    }

    const elapsed = candle.receivedAt - previousReceivedAt;

    if (elapsed < 0) {
      return null;
    }

    if (elapsed === 0) {
      return previousValue;
    }

    const effectiveTau = this.getEffectiveTau(candle);

    if (!Number.isFinite(effectiveTau) || effectiveTau <= 0) {
      return null;
    }

    const alpha = 1 - Math.exp(-elapsed / effectiveTau);

    return previousValue + alpha * (input - previousValue);
  }

  private updateState(
    marketName: string,
    value: IndicatorValue,
    receivedAt: number | null,
  ): void {
    if (
      value === null ||
      receivedAt === null ||
      !Number.isFinite(value)
    ) {
      this.stateByMarket.delete(marketName);
      return;
    }

    this.stateByMarket.set(marketName, {
      value,
      receivedAt,
    });
  }
}
