// app/src/client/src/controllers/MarketStatisticsController.ts
import {
  FRONTEND_WS_SUBSCRIPTION_ACTIONS,
} from '../../../shared/constants/frontend-ws';
import {
  MARKET_STATISTICS_LEVEL_DURATIONS,
} from '../../../shared/constants/market-statistics-config';
import type {
  MarketRollingStatistics,
} from '../../../shared/types/market-statistics-rolling';
import type {
  FullMarketStatisticsPayload,
  MarketStatisticsBinaryPayload,
} from '../../../shared/utilities/market-statistics-payload-codec';
import { appEvents } from '../events/app-events';
import {
  BaseController,
  type ControllerUnusedCallback
} from './BaseController';
import {
  createInitialMarketStatisticsViewState,
  MarketStatisticsView,
  type MarketStatisticsViewState,
} from './MarketStatisticsView';
import { SECONDS } from '../../../shared/constants/time';

export interface MarketStatisticsControllerState
  extends MarketStatisticsViewState {
  rollingStatistics: MarketRollingStatistics | null;
}

export type MarketStatisticsChartMode = {
  interval: number;
};

const defaultInterval =
  MARKET_STATISTICS_LEVEL_DURATIONS[0].interval;

const defaultChartMode: MarketStatisticsChartMode = {
  interval: defaultInterval,
};

export const createInitialMarketStatisticsControllerState = (
  interval: number = defaultInterval,
): MarketStatisticsControllerState => ({
  ...createInitialMarketStatisticsViewState(interval),
  rollingStatistics: null,
});

export interface MarketStatisticsControllerOptions {
  chartMode?: MarketStatisticsChartMode;
  onUnused?: ControllerUnusedCallback;
}

export class MarketStatisticsController
  extends BaseController<MarketStatisticsControllerState> {
  private readonly view: MarketStatisticsView;

  private unsubscribeFullSync: (() => void) | null = null;

  private unsubscribeDelta: (() => void) | null = null;

  private unsubscribeIndicatorChanges: (() => void) | null = null;

  private unsubscribeRolling: (() => void) | null = null;

  private windowTimer: ReturnType<typeof setInterval> | null = null;

  public constructor(
    private readonly marketName: string,
    options: MarketStatisticsControllerOptions = {},
  ) {
    const chartMode =
      options.chartMode ?? defaultChartMode;

    super(
      createInitialMarketStatisticsControllerState(
        chartMode.interval,
      ),
      options.onUnused,
    );

    this.view = new MarketStatisticsView(
      marketName,
      chartMode.interval,
    );
  }

  protected override onFirstSubscriber(): void {
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

    this.unsubscribeIndicatorChanges = appEvents.on(
      'marketStatisticsIndicatorChangesReceived',
      (payload) => this.handleIndicatorChanges(payload),
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
    }, 30 * SECONDS);

    appEvents.emit(
      'changeMarketRollingSubscription',
      FRONTEND_WS_SUBSCRIPTION_ACTIONS.add,
      [this.marketName],
    );

    appEvents.emit(
      'requestMarketStatisticsFullSync',
      this.marketName,
    );

    this.notify();
  }

  protected override onLastSubscriber(): void {
    this.unsubscribeFullSync?.();
    this.unsubscribeDelta?.();
    this.unsubscribeIndicatorChanges?.();
    this.unsubscribeRolling?.();

    this.unsubscribeFullSync = null;
    this.unsubscribeDelta = null;
    this.unsubscribeIndicatorChanges = null;
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

  public setInterval(interval: number): void {
    this.patchViewState(
      this.view.setInterval(interval),
    );
  }

  private handleFullSync(
    payload: FullMarketStatisticsPayload,
  ): void {
    this.patchViewState(
      this.view.applyFullSync(payload),
    );

    appEvents.emit(
      'changeMarketStatisticsSubscription',
      FRONTEND_WS_SUBSCRIPTION_ACTIONS.add,
      [this.marketName],
    );
  }

  private handleDelta(
    payload: MarketStatisticsBinaryPayload,
  ): void {
    this.patchViewState(
      this.view.applyDelta(payload),
    );
  }

  private handleIndicatorChanges(
    payload: MarketStatisticsBinaryPayload,
  ): void {
    this.patchViewState(
      this.view.applyIndicatorChanges(payload),
    );
  }

  private handleRollingUpdated(
    rollingStatistics: MarketRollingStatistics,
  ): void {
    this.patchState({
      rollingStatistics,
    });
  }

  private refreshChartData(): void {
    this.patchViewState(
      this.view.refresh(),
    );
  }

  private patchViewState(
    viewState: MarketStatisticsViewState,
  ): void {
    this.patchState(viewState);
  }
}
