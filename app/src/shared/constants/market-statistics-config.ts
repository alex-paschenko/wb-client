import {
  convertIntervalToTimeWithUnit,
  type TimeAsCountUnit,
} from '../utilities/time';
import { DAY, DAYS, HOUR, HOURS, MINUTE, MINUTES, SECONDS } from './time';
import type {
  MarketStatisticsLevelConfig
} from '../types/market-statistics-storage.js';

export const MARKET_STATISTICS_LEVEL_CONFIGS = [
  {
    sourceType: 'snapshot',

    duration: 1 * SECONDS,
    interval: 1 * HOUR,
    chunkCapacity: 512,
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
    {
    sourceType: 'candle',

    duration: 2 * HOUR,
    interval: 7 * DAYS,
    chunkCapacity: 32,
  },
] as const satisfies readonly MarketStatisticsLevelConfig[];

interface MarketStatisticsDurations extends TimeAsCountUnit {
  interval: number;
};

const intervals = [
  5 * MINUTES,
  15 * MINUTES,
  1 * HOUR,
  3 * HOURS,
  12 * HOURS,
  1 * DAY,
  3 * DAYS,
  7 * DAYS,
];

function intervalToLevel (interval: number): number {
  let level = 0;
  let summIntervals = 0;

  for (level = 0; level++; level <= MARKET_STATISTICS_LEVEL_CONFIGS.length - 1) {
    summIntervals += MARKET_STATISTICS_LEVEL_CONFIGS[level].interval;
    if (summIntervals >= interval) {
      return level;
    }
  }

  return level;
}

export const MARKET_STATISTICS_LEVEL_DURATIONS: MarketStatisticsDurations[] =
  intervals.map((interval) => {
    return {
      ...convertIntervalToTimeWithUnit(interval),
      interval,
    }
  }
);
