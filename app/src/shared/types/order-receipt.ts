// app/src/shared/types/order-receipt.ts

import { orderTypeNames } from '../constants/order-receipt.js';

// Data persisted in order receipts. Keep the versioned binary codec in sync.

export type OrderSide = 'sell' | 'buy';

export type OrderType = (typeof orderTypeNames)[number]

export type OrderStp = 'no' | 'co' | 'cn' | 'cb';

export type OrderStatus =
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'CANCELED_STP'
  | 'CANCELED_TAKER_BAND'
  | 'CANCELED_RPI'
  | 'AUTO_CANCELED_REDUCE_ONLY'
  | 'AUTO_CANCELED_LIQUIDATION'
  | 'DELISTING';

export type OrderPositionSide = 'LONG' | 'SHORT' | 'BOTH';

export interface Order {
  id: number;
  market: string;
  type: OrderType;
  side: OrderSide;
  post_only: boolean;
  ioc: boolean;
  ctime: number;
  mtime: number;
  price: number;
  amount: number;
  left: number;
  deal_stock: number;
  deal_money: number;
  deal_fee: number;
  client_order_id: number;
  stp: OrderStp;
  status: OrderStatus;
  position_side: OrderPositionSide;
  rpi: boolean;
  retail: boolean;
  reduce_only: boolean;
}

export interface OrderError {
  code: number | string;
  message: string;
  errors?: unknown;
}

export interface OrderReceiptBody {
  order: Order | null;
  error: OrderError | null;
}
