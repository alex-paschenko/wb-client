import type {
  MarketStatisticsLevelConfig
} from '../types/market-statistics-storage.js';
import {
  DAYS,
  HOUR,
  HOURS,
  MINUTE,
  MINUTES,
  SECONDS
} from './time.js';

export const SAVE_ROLLING_INTERVAL = 60 * SECONDS;

export const MARKET_STATISTICS_LEVEL_CONFIGS = [
  {
    sourceType: 'snapshot',

    duration: 1 * SECONDS,
    interval: 1 * HOUR,
    chunkCapacity: 256,
  },
  {
    sourceType: 'candle',

    duration: 1 * MINUTE,
    interval: 5 * HOURS,
    chunkCapacity: 64,
  },
  {
    sourceType: 'candle',

    duration: 10 * MINUTES,
    interval: 18 * HOURS,
    chunkCapacity: 32,
  },
  {
    sourceType: 'candle',

    duration: 1 * HOUR,
    interval: 6 * DAYS,
    chunkCapacity: 32,
  },
] as const satisfies readonly MarketStatisticsLevelConfig[];

export const MARKET_STATISTICS_DELTA_OPERATION_TYPE = {
  addItem: 1,
  removeItems: 2,
} as const;

export type MarketStatisticsDeltaOperationType =
  typeof MARKET_STATISTICS_DELTA_OPERATION_TYPE[
    keyof typeof MARKET_STATISTICS_DELTA_OPERATION_TYPE
  ];
