// app/src/shared/utilities/codecs/definitions/float16-nullable-v1_0.ts

import { primitiveCodecDefinition } from './codec-definition-helpers';

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

export const float16Nullable_V1_0 = primitiveCodecDefinition<number | null>({
  size: 2,

  write: (offset, view, value) => {
    view.setFloat16(offset, value ?? Number.NaN, true);

    return value === null ? null : Math.f16round(value);
  },

  read: (offset, view) => {
    const value = view.getFloat16(offset, true);

    return Number.isNaN(value) ? null : value;
  },
});
