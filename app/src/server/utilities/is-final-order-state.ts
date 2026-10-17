import type { Order } from '../types/orders.js';

const FINAL_STATUSES = new Set<Order['status']>([
  'FILLED',
  'CANCELED',
  'CANCELED_STP',
  'CANCELED_TAKER_BAND',
  'CANCELED_RPI',
  'AUTO_CANCELED_REDUCE_ONLY',
  'AUTO_CANCELED_LIQUIDATION',
  'DELISTING',
]);

const IMMEDIATE_TYPES = new Set<Order['type']>([
  'Market',
  'Market stock',
  'Stop market',
  'Stop market stock',
  'Margin market',
  'Margin stop market',
]);

export function isFinalOrderState(order: Order): boolean {
  return FINAL_STATUSES.has(order.status) ||
    (order.status === 'PARTIALLY_FILLED' &&
      (order.ioc || IMMEDIATE_TYPES.has(order.type)));
}
