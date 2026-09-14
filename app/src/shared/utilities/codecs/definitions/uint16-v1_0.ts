// app/src/shared/utilities/codecs/definitions/uint16-v1_0.ts

import { primitiveCodecDefinition } from "./codec-definition-helpers";

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

export const uint16_V1_0 = primitiveCodecDefinition<number>({
  size: Uint16Array.BYTES_PER_ELEMENT,

  read: (offset, view) =>
    view.getUint16(offset, true),

  write: (offset, view, value) => {
    if (
      !Number.isInteger(value) ||
      value < 0 ||
      value > 0xffff
    ) {
      throw new RangeError(
        `Value ${value} is out of uint16 range`,
      );
    }

    view.setUint16(offset, value, true);
    return value;
  },
});
