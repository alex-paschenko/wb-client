// app/src/shared/utilities/market-indicators-codec.ts

import {
  INDICATOR_CODECS,
} from '../constants/market-indicators.js';
import type {
  IndicatorValueCodecIndex,
} from '../types/market-indicators.js';

const getCodec = (
  codecIndex: IndicatorValueCodecIndex,
) => {
  const codec = INDICATOR_CODECS[codecIndex];

  if (!codec) {
    throw new Error(`Unknown indicator codec index: ${codecIndex}`);
  }

  return codec;
};

export const getIndicatorValueByteLength = (
  codecIndex: IndicatorValueCodecIndex,
): number => (
  getCodec(codecIndex).size
);

export const writeIndicatorValue = (
  view: DataView,
  offset: number,
  codecIndex: IndicatorValueCodecIndex,
  value: number | null,
): number => {
  const codec = getCodec(codecIndex);

  codec.write(view, offset, value);

  return offset + codec.size;
};

export const readIndicatorValue = (
  view: DataView,
  offset: number,
  codecIndex: IndicatorValueCodecIndex,
): {
  value: number | null;
  nextOffset: number;
} => {
  const codec = getCodec(codecIndex);

  return {
    value: codec.read(view, offset),
    nextOffset: offset + codec.size,
  };
};
