import type { SignalChangedEvent } from './signal.js';
import type {
  FrontendWsServerControlMessage,
} from './frontend-ws.js';
import type {
  MarketRollingStatisticsByMarket,
} from './market-statistics-rolling.js';

export const SERVER_WS_EVENT_TYPE = {
  signalChanged: 'signal-changed',
  marketRollingUpdated: 'market-rolling-updated',
} as const;

export interface MarketRollingUpdatedWsEvent {
  type: typeof SERVER_WS_EVENT_TYPE.marketRollingUpdated;
  payload: {
    rollingStatisticsByMarket: MarketRollingStatisticsByMarket;
  };
}

export type ServerWsEvent =
  | SignalChangedEvent
  | MarketRollingUpdatedWsEvent;

export type ServerWsJsonMessage =
  | ServerWsEvent
  | FrontendWsServerControlMessage;