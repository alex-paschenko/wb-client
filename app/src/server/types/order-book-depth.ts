// app/src/server/types/order-book-depth.ts

import type { Strategy } from './strategies.js';
export type {
  OrderBookDepth,
  OrderBookDepthBet,
} from '../../shared/types/order-book-depth.js';

export type RawOrderBookDepthBet = [price: string, amount: string];

export interface RawOrderBookDepthFullBody {
  timestamp: number;
  event_time: number;
  asks: RawOrderBookDepthBet[];
  bids: RawOrderBookDepthBet[];
  update_id: number;
}

export interface RawOrderBookDepthIncrementalBody
  extends RawOrderBookDepthFullBody {
    past_update_id: number;
  }

export type RawOrderBookDepthBody =
  | RawOrderBookDepthFullBody
  | RawOrderBookDepthIncrementalBody

export type RawOrderBookDepthFull = [
  isFullBody: true,
  body: RawOrderBookDepthFullBody,
  marketName: string,
]

export type RawOrderBookDepthIncremental = [
  isFullBody: false,
  body: RawOrderBookDepthIncrementalBody,
  marketName: string,
]

export type RawOrderBookDepth =
  | RawOrderBookDepthFull
  | RawOrderBookDepthIncremental;

export interface OrderBookSubscription {
  marketName: string;
  action: 'subscribe' | 'unsubscribe';
}

export interface OrderBookDepthSubscriptionParams {
  subscription: OrderBookSubscription;
  strategy: Strategy;
  receivedAt: number;
}

export interface DepthApi {
  orderBookDepthSubscription: (params: OrderBookDepthSubscriptionParams) => boolean;
}
