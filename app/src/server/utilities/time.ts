// app/src/server/utilities/time.ts

import { SPEED_RESPONSE_90_TAU_RATIO } from "../constants/time";

export function getMiddleTimestamp(
  startedAt: number,
  endedAt: number,
): number {
  return Math.round(startedAt + (endedAt - startedAt) / 2);
}

export const getMarketPhaseTau = (responseTime: number): number =>
  responseTime / SPEED_RESPONSE_90_TAU_RATIO;
