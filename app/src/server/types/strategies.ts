// app/src/server/types/strategies.ts

import type { MarketForecastValue } from '../../shared/types/data-types.js';
import {
  oneMarketTwoDealsStrategyState,
  strategyChangeType,
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

export type StrategyStates<T extends string> = {
  action: 'continue' | 'stop';
} & (
  | {
      kind: Extract<StrategyStateChangeKind, 'bare'>;
      state: StrategyState<T>;
    }
  | {
      kind: Extract<StrategyStateChangeKind, 'error'>;
      state: StrategyState<T>;
      errorCode: number;
    }
  | {
      kind: Extract<StrategyStateChangeKind, 'rests'>;
      state: StrategyState<T>;
      stock: number;
      money: number;
    }
);

export interface Strategy<T extends string = string> {
  name: string;
  run: (params: StrategyRunParams<T>) => void;
}

export type StrategyStateChangeKind =
  (typeof strategyChangeType)[keyof typeof strategyChangeType];

export interface StrategyStateBareChange<T extends string> {
  kind: Extract<StrategyStateChangeKind, 'bare'>;
  receivedAt: number;
  state: T;
}

export interface StrategyStateErrorChange<T extends string> {
  kind: Extract<StrategyStateChangeKind, 'error'>;
  receivedAt: number;
  state: T;
  errorCode: number;
}

export interface StrategyStateRestsChange<T extends string> {
  kind: Extract<StrategyStateChangeKind, 'rests'>;
  receivedAt: number;
  state: T;
  stock: number;
  money: number;
}

export type StrategyStateChange<T extends string> =
  | StrategyStateBareChange<T>
  | StrategyStateErrorChange<T>
  | StrategyStateRestsChange<T>;

export interface StrategyRests {
  stock: number;
  money: number;
}
