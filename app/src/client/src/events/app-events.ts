// app/src/client/src/events/app-events.ts
import type {
  FrontendSettings,
} from '../../../shared/services/frontend-settings';
import type {
  FrontendWsSubscriptionAction,
} from '../../../shared/types/frontend-ws';
import type {
  MarketRollingStatistics,
} from '../../../shared/types/market-statistics-rolling';
import type {
  FullMarketStatisticsPayload,
  MarketStatisticsBinaryPayload,
} from '../../../shared/utilities/market-statistics-payload-codec';
import {
  EventEmitter,
  type EventMapBase,
} from '../utilities/event-emitter';
import type {
  MarketIndicatorsRegistry,
} from '../../../shared/types/market-indicators';
import type {
  MarketsByName,
} from '../../../shared/types/market';

type AppEventMap = EventMapBase & {
  frontendWsConnectionStateChanged: [
    isConnected: boolean,
  ];

  synchronizationStateChanged: [
    stateKey: string,
  ];

  requestSettings: [];

  subscribeMarketInfo: [];

  requestMarketIndicatorsRegistry: [];

  synchronizationCompleted: [];

  synchronizationFailed: [
    error: unknown,
  ];

  startupSettingsReceived: [
    settings: FrontendSettings,
  ];

  synchronizationSettingsProcessed: [
    settings: FrontendSettings,
  ];

  startupIndicatorRegistryReceived: [
    registry: MarketIndicatorsRegistry,
  ];

  requestMarketStatisticsFullSync: [
    marketName: string,
  ];

  settingsChanged: [
    settings: FrontendSettings,
  ];

  marketsUpdated: [
    markets: MarketsByName,
  ];

  changeMarketStatisticsSubscription: [
    action: FrontendWsSubscriptionAction,
    markets: string[],
  ];

  changeMarketRollingSubscription: [
    action: FrontendWsSubscriptionAction,
    markets: string[],
  ];

  marketRollingUpdated: [
    marketName: string,
    rollingStatistics: MarketRollingStatistics,
  ];

  marketStatisticsFullSyncReceived: [
    payload: FullMarketStatisticsPayload,
  ];

  marketStatisticsDeltaReceived: [
    payload: MarketStatisticsBinaryPayload,
  ];

  marketStatisticsIndicatorChangesReceived: [
    payload: MarketStatisticsBinaryPayload,
  ];
};

export const appEvents = new EventEmitter<AppEventMap>();
