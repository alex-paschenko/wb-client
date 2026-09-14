// app/src/client/src/controllers/MarketStatisticsView.ts

import type { UTCTimestamp } from 'lightweight-charts';

import { CANDLE_NAME } from '../../../shared/constants/storage-entities';
import {
  MARKET_STATISTICS_LEVEL_DURATIONS,
} from '../../../shared/constants/storage-config';
import { SECOND } from '../../../shared/constants/time';
import type { Storage } from '../../../shared/services/storage';
import type { MarketCandle } from '../../../shared/types/data-types';
import type { LazyArray } from '../../../shared/utilities/lazy-array';

export type MarketChartVisibleRange = {
  from: UTCTimestamp;
  to: UTCTimestamp;
};

export type MarketChartUpdateMode = 'replace' | 'append';

export interface MarketStatisticsViewState {
  pointsCount: number;
  chartVersion: number;
  chartUpdateMode: MarketChartUpdateMode;
  selectedInterval: number;
  visibleRange: MarketChartVisibleRange;
  startIndex: number;
  endIndex: number;
}

const defaultInterval =
  MARKET_STATISTICS_LEVEL_DURATIONS[0].interval;

const ONE_SECOND = 1 * SECOND;

const createVisibleRange = (
  interval: number,
): MarketChartVisibleRange => {
  const now = Date.now();

  return {
    from: Math.floor((now - interval) / ONE_SECOND) as UTCTimestamp,
    to: Math.floor(now / ONE_SECOND) as UTCTimestamp,
  };
};

export const createInitialMarketStatisticsViewState = (
  interval: number = defaultInterval,
): MarketStatisticsViewState => ({
  pointsCount: 0,
  chartVersion: 0,
  chartUpdateMode: 'replace',
  selectedInterval: interval,
  visibleRange: createVisibleRange(interval),
  startIndex: 0,
  endIndex: -1,
});

export class MarketStatisticsView {
  private state: MarketStatisticsViewState;

  public constructor(
    private interval: number = defaultInterval,
  ) {
    this.state = createInitialMarketStatisticsViewState(interval);
  }

  public getState(): MarketStatisticsViewState {
    return this.state;
  }

  public setInterval(
    storage: Storage | null,
    interval: number,
  ): MarketStatisticsViewState {
    this.interval = interval;

    return this.refresh(storage, 'replace');
  }

  public refresh(
    storage: Storage | null,
    updateMode: MarketChartUpdateMode = 'replace',
  ): MarketStatisticsViewState {
    const visibleRange = createVisibleRange(this.interval);

    if (!storage || storage.size === 0) {
      this.state = {
        ...this.state,
        pointsCount: 0,
        chartVersion: this.state.chartVersion + 1,
        chartUpdateMode: 'replace',
        selectedInterval: this.interval,
        visibleRange,
        startIndex: 0,
        endIndex: -1,
      };

      return this.state;
    }

    const { startIndex, endIndex } =
      this.getVisibleIndexes(storage);

    this.state = {
      ...this.state,
      pointsCount:
        endIndex >= startIndex
          ? endIndex - startIndex + 1
          : 0,
      chartVersion: this.state.chartVersion + 1,
      chartUpdateMode: updateMode,
      selectedInterval: this.interval,
      visibleRange,
      startIndex,
      endIndex,
    };

    return this.state;
  }

  private getVisibleIndexes(
    storage: Storage,
  ): {
    startIndex: number;
    endIndex: number;
  } {
    const candles =
      storage.getAccessors().candles[CANDLE_NAME] as LazyArray<MarketCandle>;

    if (!candles || candles.length === 0) {
      return {
        startIndex: 0,
        endIndex: -1,
      };
    }

    const cutoff = Date.now() - this.interval;
    const endIndex = candles.length - 1;

    let startIndex = endIndex;

    while (startIndex > 0) {
      const previousEndedAt = candles.get(startIndex - 1, 'endedAt');

      if (previousEndedAt < cutoff) {
        break;
      }

      startIndex--;
    }

    return {
      startIndex,
      endIndex,
    };
  }
}
