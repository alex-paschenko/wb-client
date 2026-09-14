// app/src/shared/utilities/codecs/definitions/float64-nullable-v1_0.ts

import { primitiveCodecDefinition } from './codec-definition-helpers';

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

export const float64Nullable_V1_0 = primitiveCodecDefinition<number | null>({
  size: 8,

  write: (offset, view, value) => {
    view.setFloat64(offset, value ?? Number.NaN, true);

    return value;
  },

  read: (offset, view) => {
    const value = view.getFloat64(offset, true);

    return Number.isNaN(value) ? null : value;
  },
});
