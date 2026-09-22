// app/src/server/utilities/entity.ts

import { convertIntervalToTimeWithUnit } from '../../shared/utilities/time';

export const buildPhaseIndicatorName = (responseTime: number) => {
  const { count, abbreviation } =
        convertIntervalToTimeWithUnit(responseTime);

  return `phase-${count}${abbreviation}`;
};
