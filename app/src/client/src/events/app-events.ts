// app/src/client/src/events/app-events.ts

import type {
  FrontendSettings,
} from '../../../shared/services/frontend-settings';
import type {
  FrontendWsSubscriptionAction,
} from '../../../shared/types/frontend-ws';
import type { MarketRollingStatistics } from
  '../../../shared/types/market-statistics-rolling';
import type { MarketsByName } from '../../../shared/types/market';
import type { EntityDesriptor } from '../../../shared/types/storage-entities';
import type { PredecodedBinary } from
  '../../../shared/utilities/codecs/entire-binary-codec';
import {
  EventEmitter,
  type EventMapBase,
} from '../utilities/event-emitter';

type AppEventMap = EventMapBase & {
  frontendWsConnectionStateChanged: [ isConnected: boolean ];

  synchronizationStateChanged: [ stateKey: string ];

  requestSettings: [];

  subscribeMarketInfo: [];

  requestStorageEntities: [];

  synchronizationCompleted: [];

  synchronizationFailed: [ error: unknown ];

  startupSettingsReceived: [ settings: FrontendSettings ];

  synchronizationSettingsProcessed: [ settings: FrontendSettings ];

  startupStorageEntitiesReceived: [ entities: EntityDesriptor[] ];

  requestMarketStatisticsFullSync: [ marketName: string ];

  settingsChanged: [ settings: FrontendSettings ];

  marketsUpdated: [ markets: MarketsByName ];

  changeMarketStatisticsSubscription: [
    action: FrontendWsSubscriptionAction,
    markets: string[],
  ];

  changeMarketRollingSubscription: [
    action: FrontendWsSubscriptionAction,
    markets: string[],
  ];

  marketRollingUpdated: [
    clientId: number,
    rollingStatistics: MarketRollingStatistics,
  ];

  storageSnapshotReceived: [
    clientId: number,
    binary: PredecodedBinary,
  ];

  storageDeltaReceived: [
    clientId: number,
    binary: PredecodedBinary,
  ];
};

type AppEventResultMap = {
  requestSettings: number;
  subscribeMarketInfo: number;
  requestStorageEntities: number;

  requestMarketStatisticsFullSync: number;

  changeMarketStatisticsSubscription: number;
  changeMarketRollingSubscription: number;
};

export const appEvents = new EventEmitter<
  AppEventMap,
  AppEventResultMap
>();
