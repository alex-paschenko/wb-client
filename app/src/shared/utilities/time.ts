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
  abbreviation: string;
};

const convertRules: TimeAsCountUnit[] = [
  { count: 1000, unit: 'seconds', abbreviation: 's' },
  { count: 60, unit: 'minutes', abbreviation: 'm' },
  { count: 60, unit: 'hours', abbreviation: 'h' },
  { count: 24, unit: 'days', abbreviation: 'd' },
];

export function convertIntervalToTimeWithUnit (
  intervalMs: number,
): TimeAsCountUnit {
  let intervalWithUnit: TimeAsCountUnit = {
    count: intervalMs,
    unit: 'milliseconds',
    abbreviation: 'ms',
  };

  for (const rule of convertRules) {
    const newIinterval = intervalWithUnit.count / rule.count;
    if (newIinterval < 1) {
      break;
    }

    intervalWithUnit = {
      count: newIinterval,
      unit: rule.unit,
      abbreviation: rule.abbreviation,
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

export const getCumulativeCutoffs = (
  now: number,
): number[] => {
  let retentionDepth = 0;

  return MARKET_STATISTICS_LEVEL_CONFIGS.map(
    (config) => {
      retentionDepth += config.interval;

      return now - retentionDepth;
    },
  );
};
