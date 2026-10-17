// app/src/server/types/orders.ts

import { orderSides, orderTypes } from "../constants/orders.js";
import type { Strategy } from './strategies.js';
export type {
  Order, OrderError, OrderStp, OrderStatus, OrderPositionSide,
} from '../../shared/types/order-receipt.js';
import type {
  Order, OrderError, OrderStp,
} from '../../shared/types/order-receipt.js';

export type OrderSide = typeof orderSides[keyof typeof orderSides];

export type OrderType = typeof orderTypes[keyof typeof orderTypes];

export interface OrderMarketRequest {
  marketName: string;
  side: OrderSide;
  amount: string;
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

export type OrderPrice = 'market' | 'limit';

export interface OrderAndStrategy {
  client_order_id: number;
  order: Order | null;
  error: OrderError | null;
  paperTrading: boolean;
  strategy: Strategy;
  orderKind: OrderKind;
}

export interface OrderApi {
  createMarketOrder: (
    strategy: Strategy,
    request: OrderMarketPreRequest,
    orderKind: OrderKind,
  ) => void;
  createLimitOrder: (
    strategy: Strategy,
    request: OrderLimitPreRequest,
    orderKind: OrderKind,
  ) => void;
  cancelOrder: (market: string, client_order_id: number) => void;
  removeAllOrdersFromCache: (
    strategy: Strategy,
    market: string,
  ) => void;
}
