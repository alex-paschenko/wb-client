// app/src/server/constants/strategies.ts

import { revert } from '../../shared/utilities/object.js';

export const strategyChangeType = {
  0: 'bare',
  1: 'error',
  2: 'rests',
} as const;

export const revertStrategyChangeType = revert(strategyChangeType);

export const strategyIdleState = 'idle';

export const oneMarketTwoDealsStrategyState = [
  'candidate',
  'awaiting for order book depth data',
  'awaiting for first main order creation',
  'holding',
  'awaiting for second main order creation',
  'unsubscribe and switch to idle'
] as const;

