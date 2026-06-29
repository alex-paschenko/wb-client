import type {
  LineData,
  UTCTimestamp,
} from 'lightweight-charts';

import {
  FRONTEND_WS_SUBSCRIPTION_ACTIONS,
} from '../../../shared/constants/frontend-ws';
import { MarketStatisticsStorageService } from '../../../shared/services/market-statistics-storage';
import type {
  MarketSnapshot,
} from '../../../shared/types/market-statistics-storage';
import type {
  FullMarketStatisticsPayload,
  MarketStatisticsDeltaPayload,
} from '../../../shared/utilities/market-statistics-payload-codec';
import {
  appEvents,
} from '../events/app-events';
import type {
  MarketRollingStatistics,
} from '../../../shared/types/market-statistics-rolling';

export type MarketChartLinePoint = LineData<UTCTimestamp>;

export interface MarketStatisticsControllerState {
  pointsCount: number;
  fullSyncVersion: number;
  chartData: MarketChartLinePoint[];
  lastSnapshot: MarketSnapshot | null;
  rollingStatistics: MarketRollingStatistics | null;
}

type StateListener = (
  state: MarketStatisticsControllerState,
) => void;

export class MarketStatisticsController {
  private storage: MarketStatisticsStorageService | null = null;

  private state: MarketStatisticsControllerState = {
    pointsCount: 0,
    fullSyncVersion: 0,
    chartData: [],
    lastSnapshot: null,
    rollingStatistics: null,
  };

  private rollingStatistics: MarketRollingStatistics | null = null;

  private unsubscribeFullSync: (() => void) | null = null;
  private unsubscribeDelta: (() => void) | null = null;
  private unsubscribeRolling: (() => void) | null = null;

  public constructor(
    private readonly marketName: string,
    private readonly onStateChanged: StateListener,
  ) {}

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

    this.unsubscribeFullSync = null;
    this.unsubscribeDelta = null;

    this.unsubscribeRolling?.();
    this.unsubscribeRolling = null;

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

    this.state = {
      pointsCount: storage.getPointSeriesLength(),
      fullSyncVersion: this.state.fullSyncVersion + 1,
      chartData: this.createLineData(storage),
      lastSnapshot: storage.getLastItem(0) as MarketSnapshot | null,
      rollingStatistics: this.rollingStatistics,
    };

    this.emitState();

    appEvents.emit(
      'changeMarketStatisticsSubscription',
      FRONTEND_WS_SUBSCRIPTION_ACTIONS.add,
      [this.marketName],
    );
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

  private handleDelta(
    payload: MarketStatisticsDeltaPayload,
  ): void {
    if (!this.storage) {
      return;
    }

    this.storage.applyDelta(payload.delta);

    this.state = {
      ...this.state,
      pointsCount: this.storage.getPointSeriesLength(),
      lastSnapshot: this.storage.getLastItem(0) as MarketSnapshot | null,
    };

    this.emitState();
  }

  private emitState(): void {
    this.onStateChanged(this.state);
  }

  private createLineData(
    storage: MarketStatisticsStorageService,
  ): MarketChartLinePoint[] {
    const items = storage.createItems('direct');
    const dataByTime = new Map<UTCTimestamp, MarketChartLinePoint>();

    for (let index = 0; index < items.length; index += 1) {
      const snapshot = items.get(index);
      const time = this.toChartTime(snapshot.receivedAt);

      dataByTime.set(time, {
        time,
        value: snapshot.price,
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
