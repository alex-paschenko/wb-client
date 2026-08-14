// app/src/server/indicators/recursive-filter-indicator.ts

import type {
  IndicatorValue,
} from '../../shared/types/market-indicators.js';
import type {
  MarketCandle,
} from '../../shared/types/market-statistics-storage.js';
import type {
  MarketIndicatorCalculationParams,
} from '../types/market-indicators.js';
import type {
  IndicatorAffectedRange,
} from './base-indicator.js';
import {
  getLastRemovedIndicatorValue,
} from './indicator-values.js';
import { IncrementalIndicator } from './incremental-indicator.js';

interface RecursiveFilterState {
  value: number;
  receivedAt: number;
}

export abstract class RecursiveFilterIndicator
  extends IncrementalIndicator<RecursiveFilterState> {
  protected readonly infiniteRange = true;

  protected readonly definition = {
    codec: 'float32',
    group: 'speed',
    requiresRemovedValues: true,
  } as const;

  protected constructor(
    protected readonly tau: number,
  ) {
    super(0);

    if (!Number.isFinite(tau) || tau <= 0) {
      throw new Error(
        `Indicator tau must be a positive finite number: ${tau}`,
      );
    }
  }

  public override calculate(
    params: MarketIndicatorCalculationParams,
  ): void {
    if (params.ascending.candles.length === 0) {
      return;
    }

    if (params.aggregatedItemDescriptors.length === 0) {
      const values = this.getAscendingValues(params);
      values[values.length - 1] = this.singleCalculate(params);
      return;
    }

    const affectedRanges = this.buildAffectedInfiniteRange(
      params.aggregatedItemDescriptors,
      params.ascending.candles.length,
    );

    this.rangeCalculate(params, affectedRanges);
  }

  protected fullCalculate(
    params: MarketIndicatorCalculationParams,
  ): number | null {
    let previousValue: IndicatorValue = null;
    let previousReceivedAt: number | null = null;

    const candles = params.ascending.candles;
    const storedValues = this.getAscendingValues(params);

    for (let index = 0; index < candles.length; index += 1) {
      const candle = candles[index];
      const storedValue = storedValues[index];

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

    this.updateState(
      params.marketName,
      previousValue,
      previousReceivedAt,
    );

    return previousValue;
  }

  protected incrementalCalculate(
    params: MarketIndicatorCalculationParams,
  ): number | null {
    const state = this.stateByMarket.get(params.marketName);
    const candles = params.descending.candles;

    if (!state || candles.length === 0) {
      return this.fullCalculate(params);
    }

    const newestCandle = candles[0];

    if (newestCandle.receivedAt <= state.receivedAt) {
      return state.value;
    }

    const value = this.calculateNextValue(
      state.value,
      state.receivedAt,
      newestCandle,
    );

    this.updateState(
      params.marketName,
      value,
      newestCandle.receivedAt,
    );

    return value;
  }

  public rangeCalculate(
    params: MarketIndicatorCalculationParams,
    affectedRanges: IndicatorAffectedRange[],
  ): void {
    const values = this.getAscendingValues(params);

    for (const range of affectedRanges) {
      const lastValue = this.calculateRange(
        params,
        range,
        values,
      );

      if (range.endIndexAsc !== values.length - 1) {
        continue;
      }

      const candle = params.ascending.candles[range.endIndexAsc];

      this.updateState(
        params.marketName,
        lastValue,
        candle.receivedAt,
      );
    }
  }

  protected abstract getInput(candle: MarketCandle): number | null;

  protected getEffectiveTau(_candle: MarketCandle): number {
    return this.tau;
  }

  private calculateRange(
    params: MarketIndicatorCalculationParams,
    range: IndicatorAffectedRange,
    values: ReturnType<RecursiveFilterIndicator['getAscendingValues']>,
  ): IndicatorValue {
    const candles = params.ascending.candles;

    const descriptorsByIndex = new Map(
      range.aggregatedCandles.map((descriptor) => [
        descriptor.indexAsc,
        descriptor,
      ]),
    );

    let previousValue: IndicatorValue =
      range.startIndexAsc > 0
        ? values[range.startIndexAsc - 1]
        : null;

    let previousReceivedAt: number | null =
      range.startIndexAsc > 0
        ? candles[range.startIndexAsc - 1].receivedAt
        : null;

    for (
      let index = range.startIndexAsc;
      index <= range.endIndexAsc;
      index += 1
    ) {
      const candle = candles[index];
      const descriptor = descriptorsByIndex.get(index);

      if (descriptor) {
        previousValue = getLastRemovedIndicatorValue(
          descriptor,
          this.name,
        );

        previousReceivedAt = candle.receivedAt;
        values[index] = previousValue;
        continue;
      }

      previousValue = this.calculateNextValue(
        previousValue,
        previousReceivedAt,
        candle,
      );

      previousReceivedAt = candle.receivedAt;
      values[index] = previousValue;
    }

    return previousValue;
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

    if (
      !Number.isFinite(effectiveTau) ||
      effectiveTau <= 0
    ) {
      return null;
    }

    const alpha = 1 - Math.exp(-elapsed / effectiveTau);

    return previousValue +
      alpha * (input - previousValue);
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
