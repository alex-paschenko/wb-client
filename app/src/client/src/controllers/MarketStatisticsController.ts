import type {
  CandlestickData,
  LineData,
  UTCTimestamp,
} from 'lightweight-charts';

import {
  FRONTEND_WS_SUBSCRIPTION_ACTIONS,
} from '../../../shared/constants/frontend-ws';
import {
  MARKET_STATISTICS_LEVEL_DURATIONS,
} from '../../../shared/constants/market-statistics-config';
import { MarketStatisticsStorageService } from '../../../shared/services/market-statistics-storage';
import type {
  MarketCandle,
  MarketSnapshot,
  MarketStatisticsItem,
} from '../../../shared/types/market-statistics-storage';
import type {
  MarketRollingStatistics,
} from '../../../shared/types/market-statistics-rolling';
import type {
  FullMarketStatisticsPayload,
  MarketStatisticsDeltaPayload,
} from '../../../shared/utilities/market-statistics-payload-codec';
import {
  appEvents,
} from '../events/app-events';

export type MarketChartLinePoint = LineData<UTCTimestamp>;

export type MarketChartCandlePoint = CandlestickData<UTCTimestamp>;

export type MarketChartCandleSeries = {
  level: number;
  data: MarketChartCandlePoint[];
};

export type MarketChartVisibleRange = {
  from: UTCTimestamp;
  to: UTCTimestamp;
};

export type MarketStatisticsChartMode = {
  interval: number;
};

export interface MarketStatisticsControllerState {
  pointsCount: number;
  chartVersion: number;
  snapshotData: MarketChartLinePoint[];
  candleSeries: MarketChartCandleSeries[];
  visibleRange: MarketChartVisibleRange;
  rollingStatistics: MarketRollingStatistics | null;
}

type StateListener = (
  state: MarketStatisticsControllerState,
) => void;

const defaultInterval =
  MARKET_STATISTICS_LEVEL_DURATIONS[0].interval;

const defaultChartMode: MarketStatisticsChartMode = {
  interval: defaultInterval,
};

const createVisibleRange = (
  interval: number,
): MarketChartVisibleRange => {
  const now = Date.now();

  return {
    from: Math.floor((now - interval) / 1000) as UTCTimestamp,
    to: Math.floor(now / 1000) as UTCTimestamp,
  };
};

export const createInitialMarketStatisticsControllerState =
  (
    interval: number = defaultInterval,
  ): MarketStatisticsControllerState => ({
    pointsCount: 0,
    chartVersion: 0,
    snapshotData: [],
    candleSeries: [],
    visibleRange: createVisibleRange(interval),
    rollingStatistics: null,
  });

export class MarketStatisticsController {
  private storage: MarketStatisticsStorageService | null = null;

  private chartMode: MarketStatisticsChartMode = defaultChartMode;

  private state: MarketStatisticsControllerState =
    createInitialMarketStatisticsControllerState();

  private unsubscribeFullSync: (() => void) | null = null;
  private unsubscribeDelta: (() => void) | null = null;
  private unsubscribeRolling: (() => void) | null = null;
  private windowTimer: ReturnType<typeof setInterval> | null = null;

  public constructor(
    private readonly marketName: string,
    private readonly onStateChanged: StateListener,
    chartMode: MarketStatisticsChartMode = defaultChartMode,
  ) {
    this.chartMode = chartMode;
    this.state = createInitialMarketStatisticsControllerState(
      chartMode.interval,
    );
  }

  public start(): void {
    this.unsubscribeFullSync = appEvents.on(
      'marketStatisticsFullSyncReceived',
      (payload) => this.handleFullSync(payload),
      this.marketName,
    );

    this.unsubscribeDelta = appEvents.on(
      'marketStatisticsDeltaReceived',
      (payload) => this.handleDelta(payload),
      this.marketName,
    );

    this.unsubscribeRolling = appEvents.on(
      'marketRollingUpdated',
      (_marketName, rollingStatistics) => {
        this.handleRollingUpdated(rollingStatistics);
      },
      this.marketName,
    );

    this.windowTimer = setInterval(() => {
      this.refreshChartData();
    }, 30_000);

    appEvents.emit(
      'changeMarketRollingSubscription',
      FRONTEND_WS_SUBSCRIPTION_ACTIONS.add,
      [this.marketName],
    );

    appEvents.emit(
      'requestMarketStatisticsFullSync',
      this.marketName,
    );

    this.emitState();
  }

  public stop(): void {
    this.unsubscribeFullSync?.();
    this.unsubscribeDelta?.();
    this.unsubscribeRolling?.();

    this.unsubscribeFullSync = null;
    this.unsubscribeDelta = null;
    this.unsubscribeRolling = null;

    if (this.windowTimer) {
      clearInterval(this.windowTimer);
      this.windowTimer = null;
    }

    appEvents.emit(
      'changeMarketRollingSubscription',
      FRONTEND_WS_SUBSCRIPTION_ACTIONS.remove,
      [this.marketName],
    );

    appEvents.emit(
      'changeMarketStatisticsSubscription',
      FRONTEND_WS_SUBSCRIPTION_ACTIONS.remove,
      [this.marketName],
    );
  }

  public setChartMode(chartMode: MarketStatisticsChartMode): void {
    this.chartMode = chartMode;
    this.refreshChartData();
  }

  private handleFullSync(
    payload: FullMarketStatisticsPayload,
  ): void {
    const storage =
      new MarketStatisticsStorageService(this.marketName);

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
    this.refreshChartData();

    appEvents.emit(
      'changeMarketStatisticsSubscription',
      FRONTEND_WS_SUBSCRIPTION_ACTIONS.add,
      [this.marketName],
    );
  }

  private handleDelta(
    payload: MarketStatisticsDeltaPayload,
  ): void {
    if (!this.storage) {
      return;
    }

    this.storage.applyDelta(payload.delta);
    this.refreshChartData();
  }

  private handleRollingUpdated(
    rollingStatistics: MarketRollingStatistics,
  ): void {
    this.state = {
      ...this.state,
      rollingStatistics,
    };

    this.emitState();
  }

  private refreshChartData(): void {
    const visibleRange = createVisibleRange(this.chartMode.interval);

    if (!this.storage) {
      this.state = {
        ...this.state,
        visibleRange,
      };

      this.emitState();
      return;
    }

    const chartData = this.createChartData(this.storage);

    this.state = {
      ...this.state,
      pointsCount: this.storage.size(),
      chartVersion: this.state.chartVersion + 1,
      snapshotData: chartData.snapshotData,
      candleSeries: chartData.candleSeries,
      visibleRange,
    };

    this.emitState();
  }

  private createChartData(
    storage: MarketStatisticsStorageService,
  ): {
    snapshotData: MarketChartLinePoint[];
    candleSeries: MarketChartCandleSeries[];
  } {
    const cutoff = Date.now() - this.chartMode.interval;
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

  private emitState(): void {
    this.onStateChanged(this.state);
  }

  private toChartTime(
    receivedAt: number,
  ): UTCTimestamp {
    return Math.floor(receivedAt / 1000) as UTCTimestamp;
  }
}
