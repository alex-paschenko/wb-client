// app/src/client/src/controllers/MarketStatisticsController.ts

import {
  FRONTEND_WS_SUBSCRIPTION_ACTIONS,
} from '../../../shared/constants/frontend-ws';
import {
  MARKET_STATISTICS_LEVEL_DURATIONS,
} from '../../../shared/constants/storage-config';
import { SECONDS } from '../../../shared/constants/time';
import { Storage } from '../../../shared/services/storage';
import type {
  MarketRollingStatistics,
} from '../../../shared/types/market-statistics-rolling';
import type {
  PredecodedBinary,
} from '../../../shared/utilities/codecs/entire-binary-codec';
import { appEvents } from '../events/app-events';
import {
  BaseController,
  type ControllerUnusedCallback,
} from './BaseController';
import {
  createInitialMarketStatisticsViewState,
  MarketStatisticsView,
  type MarketStatisticsViewState,
} from './MarketStatisticsView';

export interface MarketStatisticsControllerState
  extends MarketStatisticsViewState {
  rollingStatistics: MarketRollingStatistics | null;
  storage: Storage | null;
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
  storage: null,
});

export interface MarketStatisticsControllerOptions {
  chartMode?: MarketStatisticsChartMode;
  onUnused?: ControllerUnusedCallback;
}

export class MarketStatisticsController
  extends BaseController<MarketStatisticsControllerState> {
  private readonly view: MarketStatisticsView;

  private storage: Storage | null = null;

  private unsubscribeSnapshot: (() => void) | null = null;
  private unsubscribeDelta: (() => void) | null = null;
  private unsubscribeRolling: (() => void) | null = null;

  private readonly pendingSingleRequests = new Set<number>();

  private readonly pendingSubscriptions = new Set<number>();

  private windowTimer: ReturnType<typeof setInterval> | null = null;

  public constructor(
    private readonly marketName: string,
    options: MarketStatisticsControllerOptions = {},
  ) {
    const chartMode = options.chartMode ?? defaultChartMode;

    super(
      createInitialMarketStatisticsControllerState(chartMode.interval),
      options.onUnused,
    );

    this.view = new MarketStatisticsView(chartMode.interval);
  }

  protected override onFirstSubscriber(): void {
    this.unsubscribeSnapshot = appEvents.on(
      'storageSnapshotReceived',
      (clientId, snapshot) => this.handleSnapshot(clientId, snapshot),
      this.marketName,
    );

  this.unsubscribeDelta = appEvents.on(
    'storageDeltaReceived',
    (clientId, delta) => this.handleDelta(clientId, delta),
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

    const fullSyncClientId = this.getOnlyClientId(
      appEvents.emit(
        'requestMarketStatisticsFullSync',
        this.marketName,
      ),
      'requestMarketStatisticsFullSync',
    );

    this.pendingSingleRequests.add(fullSyncClientId);

    this.notify();
  }

  protected override onLastSubscriber(): void {
    this.unsubscribeSnapshot?.();
    this.unsubscribeDelta?.();
    this.unsubscribeRolling?.();

    this.unsubscribeSnapshot = null;
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

    this.storage = null;

    this.pendingSingleRequests.clear();
    this.pendingSubscriptions.clear();
  }

  public setInterval(interval: number): void {
    this.patchViewState(
      this.view.setInterval(this.storage, interval),
    );
  }

  private handleSnapshot(
    clientId: number,
    snapshot: PredecodedBinary,
  ): void {
    if (!this.isPendingRequest(clientId)) {
      return;
    }

    const storage = new Storage(this.marketName);

    storage.applySnapshot(snapshot);

    this.storage = storage;

    this.patchState({
      ...this.view.refresh(storage, 'replace'),
      storage,
    });

    const subscriptionClientId = this.getOnlyClientId(
      appEvents.emit(
        'changeMarketStatisticsSubscription',
        FRONTEND_WS_SUBSCRIPTION_ACTIONS.add,
        [this.marketName],
      ),
      'changeMarketStatisticsSubscription',
    );

    this.pendingSubscriptions.add(subscriptionClientId);

    appEvents.emit(
      'changeMarketStatisticsSubscription',
      FRONTEND_WS_SUBSCRIPTION_ACTIONS.add,
      [this.marketName],
    );
  }

  private handleDelta(clientId: number, delta: PredecodedBinary): void {
    if (!this.isPendingRequest(clientId)) {
      return;
    }

    if (!this.storage) {
      /*
       * A delta without a snapshot cannot be applied safely.
       * Reconnect logic above the controller will eventually request
       * another full sync.
       */
      return;
    }

    const { appendOnly } = this.storage.applyDelta(delta);

    this.patchViewState(
      this.view.refresh(
        this.storage,
        appendOnly ? 'append' : 'replace',
      ),
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
      this.view.refresh(this.storage, 'replace'),
    );
  }

  private patchViewState(
    viewState: MarketStatisticsViewState,
  ): void {
    this.patchState(viewState);
  }

  private getOnlyClientId(
    results: readonly number[],
    eventName: string,
  ): number {
    if (results.length !== 1) {
      throw new Error(
        `Expected exactly one listener result for "${eventName}", ` +
        `got ${results.length}`,
      );
    }

    return results[0];
  }

  private isPendingRequest(clientId: number): boolean {
    if (this.pendingSingleRequests.delete(clientId)) {
      return true;
    }

    return this.pendingSubscriptions.has(clientId);
  }
}
