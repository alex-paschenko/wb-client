// app/src/shared/utilities/codecs/definitions/uint32-v1_0.ts

import {
  primitiveCodecDefinition,
} from './codec-definition-helpers.js';

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

export const uint32_V1_0 = primitiveCodecDefinition<number>({
  size: Uint32Array.BYTES_PER_ELEMENT,

  write: (offset, view, value) => {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 0xffffffff
    ) {
      throw new RangeError(
        `Value ${value} is out of uint32 range`,
      );
    }

    view.setUint32(offset, value, true);

    return value;
  },

  read: (offset, view) =>
    view.getUint32(offset, true),
});
