// app/src/shared/utilities/codecs/definitions/string-2-to-16-v1_0.ts

import { singleValueCodecDefinition } from './codec-definition-helpers';
import { textDecoder, textEncoder } from './general-constants';

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

export const string2To16_V1_0 = singleValueCodecDefinition<string>({
  getSize: (value): number => {
    const byteLength = textEncoder.encode(value).byteLength;

    if (byteLength > 0xffff) {
      throw new RangeError(
        `String is too long to encode: ${byteLength} bytes`,
      );
    }

    return 2 + byteLength;
  },

  write: (offset, view, value) => {
    const bytes = textEncoder.encode(value);

    if (bytes.byteLength > 0xffff) {
      throw new RangeError(
        `String is too long to encode: ${bytes.byteLength} bytes`,
      );
    }

    view.setUint16(offset, bytes.byteLength, true);

    new Uint8Array(
      view.buffer,
      view.byteOffset + offset + 2,
      bytes.byteLength,
    ).set(bytes);

    return {
      value,
      nextOffset: offset + 2 + bytes.byteLength,
    };
  },

  read: (offset, view) => {
    const byteLength = view.getUint16(offset, true);
    const nextOffset = offset + 2 + byteLength;

    const bytes = new Uint8Array(
      view.buffer,
      view.byteOffset + offset + 2,
      byteLength,
    );

    return {
      value: textDecoder.decode(bytes),
      nextOffset,
    };
  },
});
