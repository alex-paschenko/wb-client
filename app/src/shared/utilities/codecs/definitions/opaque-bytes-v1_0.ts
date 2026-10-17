import { singleValueCodecDefinition } from './codec-definition-helpers.js';

// Opaque binary payload, length-prefixed with a little-endian uint32.
export const opaqueBytes_V1_0 =
  singleValueCodecDefinition<Uint8Array>({
    getSize: (value) => {
      if (value.byteLength > 0xffffffff) {
        throw new RangeError('Opaque binary payload is too large');
      }

      return 4 + value.byteLength;
    },

    write: (offset, view, value) => {
      view.setUint32(offset, value.byteLength, true);

      new Uint8Array(
        view.buffer, view.byteOffset + offset + 4, value.byteLength,
      ).set(value);

      return { value, nextOffset: offset + 4 + value.byteLength };
    },

    read: (offset, view) => {
      if (offset + 4 > view.byteLength) {
        throw new RangeError('Truncated opaque binary length');
      }

      const length = view.getUint32(offset, true);
      if (offset + 4 + length > view.byteLength) {
        throw new RangeError('Truncated opaque binary payload');
      }

      const value = new Uint8Array(
        view.buffer, view.byteOffset + offset + 4, length,
      );

      return { value, nextOffset: offset + 4 + length };
    },
  });
