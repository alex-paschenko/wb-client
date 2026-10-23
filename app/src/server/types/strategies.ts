// app/src/server/types/strategies.ts

import type { MarketForecastValue } from '../../shared/types/data-types.js';
import {
  oneMarketTwoDealsStrategyState,
  strategyIdleState,
} from '../constants/strategies.js';
import type { DepthApi, OrderBookDepth } from './order-book-depth.js';
import type { OrderAndStrategy, OrderApi } from './orders.js';

export type StrategyDirection = 'short' | 'long';

export type StrategyIdleState = typeof strategyIdleState;

export type OneMarketTwoDealsStrategyState =
  typeof oneMarketTwoDealsStrategyState[number];

export type StrategyState<T extends string> =
  StrategyIdleState | T;

export interface StrategyStorage {
  marketName: string;
  receivedAt: number;
  forecast: MarketForecastValue;
  price: number;
}

export interface StrategyRunParams<T extends string> {
  storage: StrategyStorage[];
  orderApi: OrderApi;
  depthApi: DepthApi;
  stateChanges: StrategyStateChange<StrategyState<T>>[];
  depthHistory: OrderBookDepth[] | null;
  orders: OrderAndStrategy[];
}

export interface StrategyStates<T extends string> {
  state: StrategyState<T>;
  action: 'continue' | 'stop';
}

export interface Strategy<T extends string = string> {
  name: string;
  run: (params: StrategyRunParams<T>) => void;
}

export interface StrategyStateChange<T extends string> {
  receivedAt: number;
  state: T;
}
