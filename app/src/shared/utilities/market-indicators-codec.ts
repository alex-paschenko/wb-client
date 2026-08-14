// app/src/shared/utilities/market-indicators-codec.ts

import {
  INDICATOR_CODECS,
} from '../constants/market-indicators.js';
import type {
  IndicatorValue,
  IndicatorValueCodecIndex,
} from '../types/market-indicators.js';

export interface WriteIndicatorResults {
  offset: number;
  value: IndicatorValue;
}

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
): WriteIndicatorResults => {
  const codec = getCodec(codecIndex);

  const writedValue = codec.write(view, offset, value);

  return { offset: offset + codec.size, value: writedValue };
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
