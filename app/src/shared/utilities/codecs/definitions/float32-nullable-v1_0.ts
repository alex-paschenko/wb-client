// app/src/shared/utilities/codecs/definitions/float32-nullable-v1_0.ts

import { primitiveCodecDefinition } from './codec-definition-helpers';

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

export const float32Nullable_V1_0 = primitiveCodecDefinition<number | null>({
  size: 4,

  write: (offset, view, value) => {
    view.setFloat32(offset, value ?? Number.NaN, true);

    return value === null ? null : Math.fround(value);
  },

  read: (offset, view) => {
    const value = view.getFloat32(offset, true);

    return Number.isNaN(value) ? null : value;
  },
});
