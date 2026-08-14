import { TIME_DERIVATIVES_SCALE } from "../../shared/constants/market-statistics-storage";

export function calculateTimeDerivative(
  fromTime: number | undefined,
  fromValue: number | undefined,
  toTime: number,
  toValue: number,
): number {
  if (
    fromTime === undefined ||
    fromValue === undefined ||
    !Number.isFinite(fromValue) ||
    !Number.isFinite(toValue)
  ) {
    return 0;
  }

  const duration = toTime - fromTime;

  if (duration <= 0) {
    return 0;
  }

  return TIME_DERIVATIVES_SCALE * (toValue - fromValue) / duration;
}

export function calculateTimeIntegral(
  fromTime: number,
  fromValue: number,
  toTime: number,
  toValue: number,
): number {
  return (
    (fromValue + toValue) *
    (toTime - fromTime) /
    2
  );
}

