// app/src/client/src/utilities/string.ts

const ELLIPSIS = '…';

export const truncateMiddle = (
  value: string,
  maxLength: number,
): string => {
  if (maxLength <= 0) {
    return '';
  }

  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength === 1) {
    return ELLIPSIS;
  }

  const availableLength = maxLength - ELLIPSIS.length;

  const headLength = Math.ceil(availableLength / 2);

  const tailLength = Math.floor(availableLength / 2);

  return [
    value.slice(0, headLength),
    ELLIPSIS,
    value.slice(value.length - tailLength),
  ].join('');
};
