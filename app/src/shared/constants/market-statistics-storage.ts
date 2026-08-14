// app/src/shared/constants/market-statistics-storage.ts

import { MINUTES, SECONDS } from './time.js';

export const SAVE_ROLLING_INTERVAL = 60 * SECONDS;

export const MARKET_STATISTICS_DELTA_OPERATION_TYPE = {
  addItem: 1,
  removeItems: 2,
} as const;

const DERIVATIVE_PERMILLE = 1000;

export const TIME_DERIVATIVES_SCALE = DERIVATIVE_PERMILLE * MINUTES;

export type MarketStatisticsDeltaOperationType =
  typeof MARKET_STATISTICS_DELTA_OPERATION_TYPE[
    keyof typeof MARKET_STATISTICS_DELTA_OPERATION_TYPE
  ];
