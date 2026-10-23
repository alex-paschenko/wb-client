// app/src/shared/types/order-receipt.ts

import type {
  orderTypeNames,
  orderSideNames,
  orderStpNames,
  orderStatusNames,
  orderPositionSideNames,
} from '../constants/orders.js';

// Data persisted in order receipts. Keep the versioned binary codec in sync.

export type OrderType = (typeof orderTypeNames)[number];
export type OrderSide = (typeof orderSideNames)[number];
export type OrderStp = (typeof orderStpNames)[number];
export type OrderStatus = (typeof orderStatusNames)[number];
export type OrderPositionSide = (typeof orderPositionSideNames)[number];

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

export type OrderErrorCode = number;

export interface OrderError {
  code: OrderErrorCode;
  isWBError: boolean;
}

export interface OrderReceiptBody {
  order: Order | null;
  error: OrderError | null;
}
