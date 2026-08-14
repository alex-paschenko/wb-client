// app/src/server/utilities/price.ts

import { TIME_DERIVATIVES_SCALE } from "../../shared/constants/market-statistics-storage";

export function calculateSpeed(
  startedAt: number | undefined,
  startPrice: number | undefined,
  endedAt: number,
  endPrice: number,
): number {
  if (
    startedAt === undefined ||
    startPrice === undefined ||
    startPrice === 0
  ) {
    return 0;
  }

  const duration = endedAt - startedAt;

  if (duration <= 0) {
    return 0;
  }

  return TIME_DERIVATIVES_SCALE *
    (endPrice - startPrice) / startPrice / duration;
}
