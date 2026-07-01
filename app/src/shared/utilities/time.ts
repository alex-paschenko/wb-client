import {
  MARKET_STATISTICS_LEVEL_CONFIGS
} from '../constants/market-statistics-config';

export type TimeUnits =
  | 'milliseconds'
  | 'seconds'
  | 'minutes'
  | 'hours'
  | 'days';

export interface TimeAsCountUnit {
  count: number;
  unit: TimeUnits;
};

const convertRules: TimeAsCountUnit[] = [
  { count: 1000, unit: 'seconds' },
  { count: 60, unit: 'minutes' },
  { count: 60, unit: 'hours' },
  { count: 24, unit: 'days' },
];

export function convertIntervalToTimeWithUnit (
  intervalMs: number,
): TimeAsCountUnit {
  let intervalWithUnit: TimeAsCountUnit = {
    count: intervalMs,
    unit: 'milliseconds',
  };

  for (const rule of convertRules) {
    const newIinterval = intervalWithUnit.count / rule.count;
    if (newIinterval < 1) {
      break;
    }

    intervalWithUnit = {
      count: newIinterval,
      unit: rule.unit,
    };
  }

  return intervalWithUnit;
};

const intervalToLevel = (interval: number): number =>
  MARKET_STATISTICS_LEVEL_CONFIGS.reduce(
    (acc, configEntry, index) => {
      if (acc.summInterval < interval) {
        acc.level = index;
        acc.summInterval += configEntry.interval;
      }
      return acc;
    },
    { level: 0, summInterval: 0 },
  ).level;