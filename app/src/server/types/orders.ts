// app/src/server/types/orders.ts

import type { Strategy } from './strategies.js';
import type {
  Order, OrderError, OrderSide, OrderStp,
} from '../../shared/types/order-receipt.js';

export interface OrderMarketRequest {
  marketName: string;
  side: OrderSide;
  amount: number;
  client_order_id: number;
  stp?: OrderStp;
}

export interface OrderLimitRequest extends OrderMarketRequest {
  price: number;
}

export type OrderMarketPreRequest = Omit<OrderMarketRequest, 'client_order_id'>;
export type OrderLimitPreRequest = Omit<OrderLimitRequest, 'client_order_id'>;

export interface OrderCancel {
  market: string;
  client_order_id: number;
  paperTrading: boolean;
}


export type OrderKind = 'main' | 'stop-loss' | 'take-profit';

export type OrderCreateType = Extract<Order['type'], 'Market' | 'Limit'>;

export type OrderCreatePreRequest =
  | { orderType: 'Market'; orderRequest: OrderMarketPreRequest }
  | { orderType: 'Limit'; orderRequest: OrderLimitPreRequest };

export type OrderCreateRequest =
  | { orderType: 'Market'; orderRequest: OrderMarketRequest }
  | { orderType: 'Limit'; orderRequest: OrderLimitRequest };

export interface OrderAndStrategy {
  client_order_id: number;
  order: Order | null;
  isFinalized: boolean;
  error: OrderError | null;
  paperTrading: boolean;
  strategy: Strategy;
  orderKind: OrderKind;
}

export interface OrderApi {
  createOrder: (
    strategy: Strategy,
    request: OrderCreatePreRequest,
    orderKind: OrderKind,
  ) => void;
  cancelOrder: (market: string, client_order_id: number) => void;
  removeAllOrdersFromCache: (
    strategy: Strategy,
    market: string,
  ) => void;
}
