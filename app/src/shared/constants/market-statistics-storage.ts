// app/src/shared/constants/market-statistics-storage.ts

import { SECONDS } from './time.js';

export const SAVE_ROLLING_INTERVAL = 60 * SECONDS;

export const MARKET_STATISTICS_DELTA_OPERATION_TYPE = {
  addItem: 1,
  removeItems: 2,
  changeItems: 3,
} as const;

export type MarketStatisticsDeltaOperationType =
  typeof MARKET_STATISTICS_DELTA_OPERATION_TYPE[
    keyof typeof MARKET_STATISTICS_DELTA_OPERATION_TYPE
  ];
