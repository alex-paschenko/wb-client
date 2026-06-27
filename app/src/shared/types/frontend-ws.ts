import {
  FRONTEND_WS_CONTROL_MESSAGE_TYPES,
  FRONTEND_WS_SUBSCRIPTION_ACTIONS,
  FRONTEND_WS_SUBSCRIPTION_ENTITIES,
} from '../constants/frontend-ws.js';
import type {
  FrontendSettingsValue,
} from './frontend-settings.js';
import type { MarketsByName } from './market.js';

export type FrontendWsClientRequest<
  Type extends string,
  Params,
> = {
  type: Type;
  clientId: number;
  params: Params;
};

export type FrontendWsServerResponse<
  Type extends string,
  Params,
> = {
  type: Type;
  clientId: number;
  params: Params;
};

export type FrontendWsServerHelloMessage = {
  type: typeof FRONTEND_WS_CONTROL_MESSAGE_TYPES.serverHello;
  latestClientVersion: string;
  serverTime: number;
};

export type FrontendWsWebSocketReadyMessage = {
  type: typeof FRONTEND_WS_CONTROL_MESSAGE_TYPES.webSocketReady;
};

export type FrontendWsClientPingMessage =
  FrontendWsClientRequest<
    typeof FRONTEND_WS_CONTROL_MESSAGE_TYPES.clientPing,
    {
      sentAt: number;
    }
  >;

export type FrontendWsServerPongMessage =
  FrontendWsServerResponse<
    typeof FRONTEND_WS_CONTROL_MESSAGE_TYPES.serverPong,
    {
      sentAt: number;
      receivedAt: number;
    }
  >;

export type FrontendWsServerPingMessage = {
  type: typeof FRONTEND_WS_CONTROL_MESSAGE_TYPES.serverPing;
  serverTime: number;
};

export type FrontendWsClientPongMessage =
  FrontendWsClientRequest<
    typeof FRONTEND_WS_CONTROL_MESSAGE_TYPES.clientPong,
    {
      serverTime: number;
      receivedAt: number;
    }
  >;

export type FrontendWsRequestSettingsMessage =
  FrontendWsClientRequest<
    typeof FRONTEND_WS_CONTROL_MESSAGE_TYPES.requestSettings,
    Record<string, never>
  >;

export type FrontendWsSettingsLoadedMessage =
  FrontendWsServerResponse<
    typeof FRONTEND_WS_CONTROL_MESSAGE_TYPES.settingsLoaded,
    {
      settings: FrontendSettingsValue;
    }
  >;

export type FrontendWsSettingsChangedMessage =
  FrontendWsClientRequest<
    typeof FRONTEND_WS_CONTROL_MESSAGE_TYPES.settingsChanged,
    {
      settings: FrontendSettingsValue;
    }
  >;

export type FrontendWsSettingsAcceptedMessage =
  FrontendWsServerResponse<
    typeof FRONTEND_WS_CONTROL_MESSAGE_TYPES.settingsAccepted,
    Record<string, never>
  >;

export type FrontendWsMarketsUpdatedMessage = {
  type: typeof FRONTEND_WS_CONTROL_MESSAGE_TYPES.marketsUpdated;
  markets: MarketsByName;
};

export type FrontendWsSetMarketInfoSubscriptionMessage =
  FrontendWsClientRequest<
    typeof FRONTEND_WS_CONTROL_MESSAGE_TYPES.setSubscription,
    {
      entity: typeof FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketInfo;
    }
  >;

export type FrontendWsRequestMarketStatisticsFullSyncMessage =
  FrontendWsClientRequest<
    typeof FRONTEND_WS_CONTROL_MESSAGE_TYPES.requestMarketStatisticsFullSync,
    {
      marketName: string;
    }
  >;

export type FrontendWsSetMarketStatisticsSubscriptionMessage =
  FrontendWsClientRequest<
    typeof FRONTEND_WS_CONTROL_MESSAGE_TYPES.setSubscription,
    {
      entity: typeof FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketStatistics;
      markets: string[];
    }
  >;

export type FrontendWsSetSubscriptionMessage =
  | FrontendWsSetMarketInfoSubscriptionMessage
  | FrontendWsSetMarketStatisticsSubscriptionMessage;

export type FrontendWsChangeSubscriptionMessage =
  FrontendWsClientRequest<
    typeof FRONTEND_WS_CONTROL_MESSAGE_TYPES.changeSubscription,
    {
      entity: typeof FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketStatistics;
      action:
        | typeof FRONTEND_WS_SUBSCRIPTION_ACTIONS.add
        | typeof FRONTEND_WS_SUBSCRIPTION_ACTIONS.remove;
      markets: string[];
    }
  >;

export type FrontendWsClientControlMessage =
  | FrontendWsWebSocketReadyMessage
  | FrontendWsClientPingMessage
  | FrontendWsClientPongMessage
  | FrontendWsRequestSettingsMessage
  | FrontendWsSettingsChangedMessage
  | FrontendWsRequestMarketStatisticsFullSyncMessage
  | FrontendWsSetSubscriptionMessage
  | FrontendWsChangeSubscriptionMessage;

export type FrontendWsServerControlMessage =
  | FrontendWsServerHelloMessage
  | FrontendWsServerPongMessage
  | FrontendWsServerPingMessage
  | FrontendWsSettingsLoadedMessage
  | FrontendWsSettingsAcceptedMessage
  | FrontendWsMarketsUpdatedMessage;
