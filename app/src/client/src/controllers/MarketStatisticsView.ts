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
  MarketSnapshot,
} from '../../../shared/types/market-statistics-storage';

import type {
  FullMarketStatisticsPayload,
  MarketStatisticsDeltaPayload,
} from '../../../shared/utilities/market-statistics-payload-codec';

export type MarketChartLinePoint = LineData;
export type MarketChartCandlePoint = CandlestickData;

export type MarketChartCandleSeries = {
  level: number;
  data: MarketChartCandlePoint[];
};

export type MarketChartVisibleRange = {
  from: UTCTimestamp;
  to: UTCTimestamp;
};

export interface MarketStatisticsViewState {
  pointsCount: number;
  chartVersion: number;
  selectedInterval: number;
  snapshotData: MarketChartLinePoint[];
  candleSeries: MarketChartCandleSeries[];
  visibleRange: MarketChartVisibleRange;
}

const defaultInterval =
  MARKET_STATISTICS_LEVEL_DURATIONS[0].interval;

const createVisibleRange = (
  interval: number,
): MarketChartVisibleRange => {
  const now = Date.now();

  return {
    from: Math.floor((now - interval) / 1000) as UTCTimestamp,
    to: Math.floor(now / 1000) as UTCTimestamp,
  };
};

export const createInitialMarketStatisticsViewState = (
  interval: number = defaultInterval,
): MarketStatisticsViewState => ({
  pointsCount: 0,
  chartVersion: 0,
  selectedInterval: interval,
  snapshotData: [],
  candleSeries: [],
  visibleRange: createVisibleRange(interval),
});

export class MarketStatisticsView {
  private storage: MarketStatisticsStorageService | null = null;

  private state: MarketStatisticsViewState;

  public constructor(
    private readonly marketName: string,
    private interval: number = defaultInterval,
  ) {
    this.state = createInitialMarketStatisticsViewState(interval);
  }

  public getState(): MarketStatisticsViewState {
    return this.state;
  }

  public setInterval(interval: number): MarketStatisticsViewState {
    this.interval = interval;

    return this.refresh();
  }

  public applyFullSync(
    payload: FullMarketStatisticsPayload,
  ): MarketStatisticsViewState {
    const storage = new MarketStatisticsStorageService(this.marketName);

    for (const [level, items] of payload.levels.entries()) {
      for (const item of items) {
        storage.addItem(
          level,
          item,
          'suppress record delta',
        );
      }
    }

    this.storage = storage;

    return this.refresh();
  }

  public applyDelta(
    payload: MarketStatisticsDeltaPayload,
  ): MarketStatisticsViewState {
    if (!this.storage) {
      return this.refresh();
    }

    this.storage.applyDelta(payload.delta);

    return this.refresh();
  }

  public refresh(): MarketStatisticsViewState {
    const visibleRange = createVisibleRange(this.interval);

    if (!this.storage) {
      this.state = {
        ...this.state,
        selectedInterval: this.interval,
        visibleRange,
      };

      return this.state;
    }

    const chartData = this.createChartData(this.storage);

    this.state = {
      ...this.state,
      pointsCount: this.storage.size(),
      chartVersion: this.state.chartVersion + 1,
      selectedInterval: this.interval,
      snapshotData: chartData.snapshotData,
      candleSeries: chartData.candleSeries,
      visibleRange,
    };

    return this.state;
  }

  private createChartData(
    storage: MarketStatisticsStorageService,
  ): {
    snapshotData: MarketChartLinePoint[];
    candleSeries: MarketChartCandleSeries[];
  } {
    const cutoff = Date.now() - this.interval;

    const snapshotData: MarketChartLinePoint[] = [];
    const candleSeries: MarketChartCandleSeries[] = [];

    for (
      let level = 0;
      level < storage.getNumOfLevels();
      level += 1
    ) {
      const items = storage.readItemsAfter(level, cutoff);
      const levelSize = storage.size(level);

      if (level === 0) {
        snapshotData.push(
          ...this.createSnapshotData(items as MarketSnapshot[]),
        );
      } else if (items.length > 0) {
        candleSeries.push({
          level,
          data: this.createCandleData(items as MarketCandle[]),
        });
      }

      if (items.length < levelSize) {
        break;
      }
    }

    return {
      snapshotData,
      candleSeries,
    };
  }

  private createSnapshotData(
    snapshots: MarketSnapshot[],
  ): MarketChartLinePoint[] {
    const dataByTime = new Map<UTCTimestamp, MarketChartLinePoint>();

    for (const snapshot of snapshots) {
      const time = this.toChartTime(snapshot.receivedAt);

      dataByTime.set(time, {
        time,
        value: snapshot.price,
      });
    }

    return [...dataByTime.values()]
      .sort((left, right) => Number(left.time) - Number(right.time));
  }

  private createCandleData(
    candles: MarketCandle[],
  ): MarketChartCandlePoint[] {
    const dataByTime = new Map<UTCTimestamp, MarketChartCandlePoint>();

    for (const candle of candles) {
      const time = this.toChartTime(candle.startedAt);

      dataByTime.set(time, {
        time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      });
    }

    return [...dataByTime.values()]
      .sort((left, right) => Number(left.time) - Number(right.time));
  }

  private toChartTime(
    receivedAt: number,
  ): UTCTimestamp {
    return Math.floor(receivedAt / 1000) as UTCTimestamp;
  }
}
