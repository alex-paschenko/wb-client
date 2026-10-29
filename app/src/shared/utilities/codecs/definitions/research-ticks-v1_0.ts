import type { ResearchTick } from '../../../types/research-storage.js';
import { singleValueCodecDefinition } from './codec-definition-helpers.js';

// Released layout: uint32 count followed by ten little-endian float64
// values per item. NaN represents a missing indicator/forecast, not zero.
// Changes to the layout require a new codec version.
const HEADER_SIZE = 4;
const ITEM_SIZE = 80;
const FIELDS = [
  'price', 'emaPrice7', 'emaLog7', 'emaLog15', 'emaLog30',
  'emaLog60', 'forecast3', 'forecast4', 'forecastCombined',
] as const satisfies readonly (keyof ResearchTick)[];

export const researchTicks_V1_0 = singleValueCodecDefinition<ResearchTick[]>({
  getSize: (ticks) => {
    if (ticks.length > 0xffffffff) throw new RangeError('Too many research ticks');
    return HEADER_SIZE + ticks.length * ITEM_SIZE;
  },
  write: (offset, view, ticks) => {
    view.setUint32(offset, ticks.length, true);
    offset += HEADER_SIZE;

    for (const tick of ticks) {
      if (!Number.isSafeInteger(tick.receivedAt) ||
        !Number.isFinite(tick.price) || tick.price <= 0) {
        throw new RangeError('Invalid research tick time or price');
      }
      view.setFloat64(offset, tick.receivedAt, true);
      offset += 8;
      for (const field of FIELDS) {
        const value = tick[field];
        if (value !== null && !Number.isFinite(value)) {
          throw new RangeError(`Invalid research ${field}`);
        }
        view.setFloat64(offset, value ?? NaN, true);
        offset += 8;
      }
    }
    return { value: ticks, nextOffset: offset };
  },
  read: (offset, view) => {
    if (offset + HEADER_SIZE > view.byteLength) {
      throw new RangeError('Truncated research tick count');
    }
    const count = view.getUint32(offset, true);
    offset += HEADER_SIZE;
    if (count > Math.floor((view.byteLength - offset) / ITEM_SIZE)) {
      throw new RangeError('Truncated research ticks');
    }
    const ticks: ResearchTick[] = [];
    for (let i = 0; i < count; i++) {
      const receivedAt = view.getFloat64(offset, true);
      if (!Number.isSafeInteger(receivedAt)) {
        throw new RangeError('Invalid research receivedAt');
      }
      const values = FIELDS.map((field, j) => {
        const value = view.getFloat64(offset + (j + 1) * 8, true);
        if (Number.isNaN(value)) return null;
        if (!Number.isFinite(value)) throw new RangeError(`Invalid research ${field}`);
        return value;
      });
      if (values[0] === null || values[0] <= 0) {
        throw new RangeError('Invalid research price');
      }
      ticks.push({
        receivedAt,
        price: values[0],
        emaPrice7: values[1],
        emaLog7: values[2],
        emaLog15: values[3],
        emaLog30: values[4],
        emaLog60: values[5],
        forecast3: values[6],
        forecast4: values[7],
        forecastCombined: values[8],
      });
      offset += ITEM_SIZE;
    }
    return { value: ticks, nextOffset: offset };
  },
});
