import type {
  FrontendWsSubscriptionAction,
} from '../../../shared/types/frontend-ws';
import type {
  FullMarketStatisticsPayload,
  MarketStatisticsDeltaPayload,
} from '../../../shared/utilities/market-statistics-payload-codec';
import type {
  FrontendSettings,
} from '../../../shared/services/frontend-settings';
import {
  EventEmitter,
  type EventMapBase,
} from '../utilities/event-emitter';
import type {
  MarketRollingStatistics,
} from '../../../shared/types/market-statistics-rolling';

type AppEventMap = EventMapBase & {
  settingsChanged: [settings: FrontendSettings];

  requestMarketStatisticsFullSync: [marketName: string];

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
    payload: MarketStatisticsDeltaPayload,
  ];
};

export const appEvents = new EventEmitter<AppEventMap>();
