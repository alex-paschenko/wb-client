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

type AppEventMap = EventMapBase & {
  settingsChanged: [settings: FrontendSettings];

  requestSettings: [];
  subscribeMarketInfo: [];

  requestMarketStatisticsFullSync: [marketName: string];

  changeMarketStatisticsSubscription: [
    action: FrontendWsSubscriptionAction,
    markets: string[],
  ];

  marketStatisticsFullSyncReceived: [
    payload: FullMarketStatisticsPayload,
  ];

  marketStatisticsDeltaReceived: [
    payload: MarketStatisticsDeltaPayload,
  ];
};

export const appEvents = new EventEmitter<AppEventMap>();
