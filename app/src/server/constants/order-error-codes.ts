// app/src/server/constants/order-error-codes.ts

import { revert } from '../../shared/utilities/object.js';

export const INTERNAL_ORDER_ERROR = {
  1000001: 'depth unavailable',
  1000010: 'paper order is no longer active',
  1000020: 'paper limit price must be positive',
  1001000: 'cannot allocate a WhiteBIT client order ID',
  1002000: 'order outcome unknown',
  1002010: 'order subscription failed',
  1002020: 'order not sent',
  1002030: 'real orders disabled',
} as const;

export const WB_ORDER_ERROR = {
  10: 'balance not enough',
  11: 'amount too small',
  12: 'not enough traders',
  42: 'order slippage threshold',
  51: 'trading in the market is not allowed',
} as const;

export const ORDER_ERROR = {
  ...WB_ORDER_ERROR,
  ...INTERNAL_ORDER_ERROR,
} as const;

export const REVERT_WB_ORDER_ERROR = revert(WB_ORDER_ERROR);

export const REVERT_ORDER_ERROR = revert(ORDER_ERROR);
