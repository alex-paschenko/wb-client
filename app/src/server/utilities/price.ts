import { SECOND } from "../../shared/constants/time";

export function calculateCandlePrice(
  open: number,
  close: number,
  high: number,
  low: number,
): number {
  return (open + close + high + low) / 4;
}

export function calculateSpeed(
  startedAt: number | undefined,
  startPrice: number | undefined,
  endedAt: number,
  endPrice: number,
): number {
  if (!startedAt || !startPrice) {
    return 0;
  }

  const seconds = (endedAt - startedAt) / SECOND;

  if (seconds <= 0) {
    return 0;
  }

  return (endPrice - startPrice) / seconds;
}
