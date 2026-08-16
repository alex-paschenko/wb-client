// app/src/shared/utilities/market-indicators-codec.ts

import { INDICATOR_CODECS } from '../constants/market-indicators.js';
import type {
  IndicatorValue,
  IndicatorValueCodecIndex,
} from '../types/market-indicators.js';

export interface WriteIndicatorResults {
  offset: number;
  value: IndicatorValue;
}

export interface WriteTrackedIndicatorResults
  extends WriteIndicatorResults {
  changed: boolean;
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

const readRawValue = (
  view: DataView,
  offset: number,
  size: number,
): number | bigint => {
  switch (size) {
    case 2:
      return view.getUint16(offset, true);

    case 4:
      return view.getUint32(offset, true);

    case 8:
      return view.getBigUint64(offset, true);

    default:
      throw new Error(`Unsupported indicator codec size: ${size}`);
  }
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
  value: IndicatorValue,
): WriteIndicatorResults => {
  const codec = getCodec(codecIndex);
  const writtenValue = codec.write(view, offset, value);

  return {
    offset: offset + codec.size,
    value: writtenValue,
  };
};

export const writeTrackedIndicatorValue = (
  view: DataView,
  offset: number,
  codecIndex: IndicatorValueCodecIndex,
  value: IndicatorValue,
): WriteTrackedIndicatorResults => {
  const codec = getCodec(codecIndex);
  const previousRawValue = readRawValue(view, offset, codec.size);

  const writtenValue = codec.write(view, offset, value);
  const writtenRawValue = readRawValue(view, offset, codec.size);

  return {
    offset: offset + codec.size,
    value: writtenValue,
    changed: previousRawValue !== writtenRawValue,
  };
};

export const readIndicatorValue = (
  view: DataView,
  offset: number,
  codecIndex: IndicatorValueCodecIndex,
): {
  value: IndicatorValue;
  nextOffset: number;
} => {
  const codec = getCodec(codecIndex);

  return {
    value: codec.read(view, offset),
    nextOffset: offset + codec.size,
  };
};
