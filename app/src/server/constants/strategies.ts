// app/src/server/constants/strategies.ts

export const strategyIdleState = 'idle';

export const oneMarketTwoDealsStrategyState = [
  'candidate',
  'awaiting for order book depth data',
  'awaiting for first main order creation',
  'holding',
  'awaiting for second main order creation',
  'unsubscribe and switch to idle'
] as const;

