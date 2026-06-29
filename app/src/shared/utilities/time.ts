export type TimeUnits =
  | 'milliseconds'
  | 'seconds'
  | 'minutes'
  | 'hours'
  | 'days';

interface CountUnit {
  count: number;
  unit: TimeUnits;
};

const convertRules: CountUnit[] = [
  { count: 1000, unit: 'seconds' },
  { count: 60, unit: 'minutes' },
  { count: 60, unit: 'hours' },
  { count: 24, unit: 'days' },
];

export function convertIntervalToTimeWithUnit (
  intervalMs: number,
): CountUnit {
  let intervalWithUnit: CountUnit = {
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
