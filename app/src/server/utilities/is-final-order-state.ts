// app/src/server/utilities/is-final-order-state.ts

import {
  orderFinalStatuses, orderImmediateTypes,
} from '../../shared/constants/orders.js';
import type { Order } from '../../shared/types/order-receipt.js';

const FINAL_STATUSES = new Set<Order['status']>(orderFinalStatuses);
const IMMEDIATE_TYPES = new Set<Order['type']>(orderImmediateTypes);

export function isFinalOrderState(order: Order): boolean {
  return FINAL_STATUSES.has(order.status) ||
    (order.status === 'PARTIALLY_FILLED' &&
      (order.ioc || IMMEDIATE_TYPES.has(order.type)));
}
