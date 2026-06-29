import {
  convertIntervalToTimeWithUnit,
  type TimeUnits,
} from '../utilities/time';
import { DAYS, HOUR, HOURS, MINUTE, MINUTES, SECONDS } from './time';
import type {
  MarketStatisticsLevelConfig
} from '../types/market-statistics-storage.js';

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

interface MarketStatisticsDurations {
  interval: number;
  unit: TimeUnits;
  count: number;
  level: number;
};

const { durations } = MARKET_STATISTICS_LEVEL_CONFIGS.reduce(
  (acc, configItem) => {
    const newInterval = acc.interval + configItem.interval;
    acc.interval = newInterval;
    acc.durations.push(newInterval);
    return acc;
  },
  { interval: 0, durations: [] } as { interval: number; durations: number[] },
);

export const MARKET_STAISTICS_LEVEL_DURATIONS: MarketStatisticsDurations[] =
  durations.map((duration, level) => ({
    ...convertIntervalToTimeWithUnit(duration),
    interval: duration,
    level,
  }));
