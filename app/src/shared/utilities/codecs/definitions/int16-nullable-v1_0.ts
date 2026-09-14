import { warnOutOfRange } from '../../number';
import { primitiveCodecDefinition } from './codec-definition-helpers';

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

export const int16Nullable_V1_0 = primitiveCodecDefinition<number | null>({
  size: 2,

  write: (offset, view, value) => {
    if (value === null) {
      view.setInt16(offset, 0x7fff, true);
      return null;
    }

    warnOutOfRange('int16 (nullable)', value, -0x8000, 0x7ffe);

    view.setInt16(offset, value, true);

    return value << 16 >> 16;
  },

  read: (offset, view) => {
    const value = view.getInt16(offset, true);

    return value === 0x7fff ? null : value;
  },
});
