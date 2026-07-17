// app/src/client/src/controllers/MarketStatisticsView.ts
import type {
  CandlestickData,
  LineData,
  UTCTimestamp,
} from 'lightweight-charts';

import {
  MARKET_STATISTICS_LEVEL_DURATIONS,
} from '../../../shared/constants/market-statistics-config';
import {
  MarketStatisticsStorageService,
} from '../../../shared/services/market-statistics-storage';
import type {
  MarketCandle,
} from '../../../shared/types/market-statistics-storage';
import type {
  FullMarketStatisticsPayload,
  MarketStatisticsDeltaPayload,
} from '../../../shared/utilities/market-statistics-payload-codec';

export type MarketChartLinePoint = LineData;
export type MarketChartCandlePoint = CandlestickData;

export type MarketChartVisibleRange = {
  from: UTCTimestamp;
  to: UTCTimestamp;
};

export interface MarketStatisticsViewState {
  pointsCount: number;
  chartVersion: number;
  selectedInterval: number;
  candleData: MarketChartCandlePoint[];
  visibleRange: MarketChartVisibleRange;
}

const defaultInterval =
  MARKET_STATISTICS_LEVEL_DURATIONS[0].interval;

const createVisibleRange = (
  interval: number,
): MarketChartVisibleRange => {
  const now = Date.now();

  return {
    from: Math.floor(
      (now - interval) / 1000,
    ) as UTCTimestamp,
    to: Math.floor(now / 1000) as UTCTimestamp,
  };
};

export const createInitialMarketStatisticsViewState = (
  interval: number = defaultInterval,
): MarketStatisticsViewState => ({
  pointsCount: 0,
  chartVersion: 0,
  selectedInterval: interval,
  candleData: [],
  visibleRange: createVisibleRange(interval),
});

export class MarketStatisticsView {
  private storage:
    MarketStatisticsStorageService | null = null;

  private state: MarketStatisticsViewState;

  public constructor(
    private readonly marketName: string,
    private interval: number = defaultInterval,
  ) {
    this.state =
      createInitialMarketStatisticsViewState(
        interval,
      );
  }

  public getState(): MarketStatisticsViewState {
    return this.state;
  }

  public setInterval(
    interval: number,
  ): MarketStatisticsViewState {
    this.interval = interval;

    return this.refresh();
  }

  public applyFullSync(
    payload: FullMarketStatisticsPayload,
  ): MarketStatisticsViewState {
    if (payload.marketName !== this.marketName) {
      throw new Error(
        `Cannot apply full sync for market ` +
        `"${payload.marketName}" to view ` +
        `"${this.marketName}"`,
      );
    }

    const storage =
      new MarketStatisticsStorageService(
        this.marketName,
      );

    storage.restoreAllItemsByLevel(
      payload.levels,
    );

    this.storage = storage;

    return this.refresh();
  }

  public applyDelta(
    payload: MarketStatisticsDeltaPayload,
  ): MarketStatisticsViewState {
    if (payload.marketName !== this.marketName) {
      throw new Error(
        `Cannot apply delta for market ` +
        `"${payload.marketName}" to view ` +
        `"${this.marketName}"`,
      );
    }

    if (!this.storage) {
      return this.refresh();
    }

    this.storage.applyDelta(
      payload.delta,
    );

    return this.refresh();
  }

  public refresh(): MarketStatisticsViewState {
    const now = Date.now();

    const visibleRange =
      createVisibleRange(this.interval);

    if (!this.storage) {
      this.state = {
        ...this.state,
        selectedInterval: this.interval,
        visibleRange,
      };

      return this.state;
    }

    const projection =
      this.storage.createIntervalProjection(
        this.interval,
        now,
      );

    const candleData =
      this.createCandleData(
        projection.candles,
      );

    this.state = {
      ...this.state,
      pointsCount: candleData.length,
      chartVersion:
        this.state.chartVersion + 1,
      selectedInterval: this.interval,
      candleData,
      visibleRange,
    };

    return this.state;
  }

  private createCandleData(
    candles: MarketCandle[],
  ): MarketChartCandlePoint[] {
    const dataByTime =
      new Map<
        UTCTimestamp,
        MarketChartCandlePoint
      >();

    for (const candle of candles) {
      const time =
        this.toChartTime(
          candle.startedAt,
        );

      dataByTime.set(time, {
        time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      });
    }

    return [...dataByTime.values()]
      .sort(
        (left, right) =>
          Number(left.time) -
          Number(right.time),
      );
  }

  private toChartTime(
    timestamp: number,
  ): UTCTimestamp {
    return Math.floor(
      timestamp / 1000,
    ) as UTCTimestamp;
  }
}
