// app/src/shared/constants/storage-config.ts

import {
  convertIntervalToTimeWithUnit,
  type TimeAsCountUnit,
} from '../utilities/time';
import {
  DAY,
  DAYS,
  HOUR,
  HOURS,
  MINUTES,
} from './time';

export const STORAGE_CHUNK_CAPACITY = 64;

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

export const MARKET_STATISTICS_LEVEL_DURATIONS: MarketStatisticsDurations[] =
  intervals.map((interval) => {
    return {
      ...convertIntervalToTimeWithUnit(interval),
      interval,
    }
  }
);
