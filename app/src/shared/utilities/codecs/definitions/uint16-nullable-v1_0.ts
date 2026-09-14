// app/src/shared/utilities/codecs/definitions/uint16-nullable-v1_0.ts

import { warnOutOfRange } from '../../number';
import { primitiveCodecDefinition } from './codec-definition-helpers';

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

export const uint16Nullable_V1_0 = primitiveCodecDefinition<number | null>({
  size: 2,

  write: (offset, view, value) => {
    if (value === null) {
      view.setUint16(offset, 0xffff, true);
      return null;
    }

    warnOutOfRange(
      'uint16 (nullable)',
      value,
      0,
      0xfffe,
    );

    view.setUint16(offset, value, true);

    return value & 0xffff;
  },

  read: (offset, view) => {
    const value = view.getUint16(offset, true);

    return value === 0xffff ? null : value;
  },
});
