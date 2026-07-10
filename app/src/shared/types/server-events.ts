import type { SignalChangedEvent } from './signal.js';
import type { FrontendWsServerControlMessage } from './frontend-ws.js';
import type {
MarketRollingStatisticsByMarket,
} from './market-statistics-rolling.js';
import type { MarketIndicators } from './market-indicators.js';

export const SERVER_WS_EVENT_TYPE = {
  signalChanged: 'signal-changed',
  marketRollingUpdated: 'market-rolling-updated',
  marketIndicatorsUpdated: 'market-indicators-updated',
} as const;

export interface MarketIndicatorsUpdatedWsEvent {
  type: typeof SERVER_WS_EVENT_TYPE.marketIndicatorsUpdated;
  payload: {
    marketName: string;
    indicators: MarketIndicators;
  };
}

export interface MarketRollingUpdatedWsEvent {
  type: typeof SERVER_WS_EVENT_TYPE.marketRollingUpdated;
  payload: {
    rollingStatisticsByMarket: MarketRollingStatisticsByMarket;
  };
}

export type ServerWsEvent =
  | SignalChangedEvent
  | MarketRollingUpdatedWsEvent
  | MarketIndicatorsUpdatedWsEvent;

export type ServerWsJsonMessage =
  | ServerWsEvent
  | FrontendWsServerControlMessage;