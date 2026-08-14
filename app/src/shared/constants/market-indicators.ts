import { warnOutOfRange } from '../utilities/number';

// app/src/shared/constants/market-indicators.ts
export const INDICATOR_NAME_MAX_LENGTH = 63;

export const INDICATOR_CODECS = [
  {
    name: 'uint16',
    size: 2,
    nullValue: 0xffff,
    write: (
      view: DataView,
      offset: number,
      value: number | null,
    ): number | null => {
      if (value === null) {
        view.setUint16(offset, 0xffff, true);
        return null;
      }

      warnOutOfRange('uint16', value, 0, 0xfffe);
      view.setUint16(offset, value, true);
      return value & 0xffff;
    },
    read: (
      view: DataView,
      offset: number,
    ): number | null => {
      const value = view.getUint16(offset, true);

      return value === 0xffff ? null : value;
    },
  },

  {
    name: 'int16',
    size: 2,
    nullValue: 0x7fff,
    write: (
      view: DataView,
      offset: number,
      value: number | null,
    ): number | null => {
      if (value === null) {
        view.setInt16(offset, 0x7fff, true);
        return null;
      }

      warnOutOfRange('int16', value, -0x8000, 0x7ffe);
      view.setInt16(offset, value, true);
      return value << 16 >> 16;
    },
    read: (
      view: DataView,
      offset: number,
    ): number | null => {
      const value = view.getInt16(offset, true);

      return value === 0x7fff ? null : value;
    },
  },

  {
    name: 'float16',
    size: 2,
    write: (
      view: DataView,
      offset: number,
      value: number | null,
    ): number | null => {
      view.setFloat16(offset, value ?? Number.NaN, true);
      return value === null ? null : Math.f16round(value);
    },
    read: (
      view: DataView,
      offset: number,
    ): number | null => {
      const value = view.getFloat16(offset, true);

      return Number.isNaN(value) ? null : value;
    },
  },

  {
    name: 'float32',
    size: 4,
    write: (
      view: DataView,
      offset: number,
      value: number | null,
    ): number | null => {
      view.setFloat32(offset, value ?? Number.NaN, true);
      return value === null ? null : Math.fround(value);
    },
    read: (
      view: DataView,
      offset: number,
    ): number | null => {
      const value = view.getFloat32(offset, true);

      return Number.isNaN(value) ? null : value;
    },
  },

  {
    name: 'float64',
    size: 8,
    write: (
      view: DataView,
      offset: number,
      value: number | null,
    ): number | null => {
      view.setFloat64(offset, value ?? Number.NaN, true);
      return value;
    },
    read: (
      view: DataView,
      offset: number,
    ): number | null => {
      const value = view.getFloat64(offset, true);

      return Number.isNaN(value) ? null : value;
    },
  },
] as const;
