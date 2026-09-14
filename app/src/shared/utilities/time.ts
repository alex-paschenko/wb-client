// app/src/shared/utilities/time.ts

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
