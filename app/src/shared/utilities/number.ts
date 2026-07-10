// app/src/shared/utilities/number.ts

export const warnOutOfRange = (
  codecName: string,
  value: number,
  min: number,
  max: number,
): void => {
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    console.error('Indicator value is out of codec range', {
      codecName,
      value,
      min,
      max,
    });
  }
};