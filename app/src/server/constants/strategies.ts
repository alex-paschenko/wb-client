// app/src/server/constants/strategies.ts

export const strategyIdleState = 'idle';

export const oneMarketTwoDealsStrategyState = [
  'candidate',
  'dealOneRequest',
  'dealOneDone',
  'dealTwoRequest',
  'dealTwoDone',
] as const;
