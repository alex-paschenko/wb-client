import type { MarketTick } from '../../../types/ticks.js';
import { singleValueCodecDefinition } from './codec-definition-helpers.js';

// Format: uint32 count, then count pairs of little-endian float64 values.
// This released format must not be changed; add a new version instead.
const HEADER_SIZE = 4;
const ITEM_SIZE = 16;

export const ticks_V1_0 = singleValueCodecDefinition<MarketTick[]>({
  getSize: (ticks) => {
    if (ticks.length > 0xffffffff) {
      throw new RangeError('Too many ticks');
    }

    return HEADER_SIZE + ticks.length * ITEM_SIZE;
  },

  write: (offset, view, ticks) => {
    view.setUint32(offset, ticks.length, true);
    offset += HEADER_SIZE;

    for (const { receivedAt, price } of ticks) {
      if (!Number.isSafeInteger(receivedAt)) {
        throw new RangeError('Invalid archive receivedAt');
      }

      view.setFloat64(offset, receivedAt, true);
      view.setFloat64(offset + 8, price ?? Number.NaN, true);
      offset += ITEM_SIZE;
    }

    return { value: ticks, nextOffset: offset };
  },

  read: (offset, view) => {
    if (offset + HEADER_SIZE > view.byteLength) {
      throw new RangeError('Truncated tick count');
    }

    const count = view.getUint32(offset, true);
    offset += HEADER_SIZE;

    if (count > Math.floor((view.byteLength - offset) / ITEM_SIZE)) {
      throw new RangeError('Truncated ticks');
    }

    const ticks: MarketTick[] = [];

    for (let index = 0; index < count; index++) {
      const receivedAt = view.getFloat64(offset, true);
      const price = view.getFloat64(offset + 8, true);

      if (!Number.isSafeInteger(receivedAt)) {
        throw new RangeError('Invalid archive receivedAt');
      }

      ticks.push({ receivedAt, price });
      offset += ITEM_SIZE;
    }

    return { value: ticks, nextOffset: offset };
  },
});
