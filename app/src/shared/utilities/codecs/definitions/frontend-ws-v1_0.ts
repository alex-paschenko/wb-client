// app/src/shared/utilities/codecs/definitions/frontend-ws-v1_0.ts

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

import type {
  FrontendWsTransportData,
} from '../../../types/frontend-ws-binary.js';
import type {
  PrimitiveCodec,
} from '../../../types/codecs.js';
import { getCodec } from '../codecs.js';
import {
  singleValueCodecDefinition,
} from './codec-definition-helpers.js';

const UINT32_CODEC = 'uint32 v1.0';

const getUint32Codec = (): PrimitiveCodec<number> => {
  const codec = getCodec(UINT32_CODEC);

  if (codec.dataKind !== 'primitive') {
    throw new TypeError(
      `Codec "${UINT32_CODEC}" must be primitive`,
    );
  }

  return codec as PrimitiveCodec<number>;
};

export const frontendWs_V1_0 =
  singleValueCodecDefinition<FrontendWsTransportData>({
    getSize: (value) => {
      const uint32Codec = getUint32Codec();

      return uint32Codec.size * 2 + value.data.byteLength;
    },

    write: (offset, view, value) => {
      const uint32Codec = getUint32Codec();

      uint32Codec.writeByOffset(offset, view, value.serverId);
      offset += uint32Codec.size;

      uint32Codec.writeByOffset(offset, view, value.clientId);
      offset += uint32Codec.size;

      new Uint8Array(
        view.buffer,
        view.byteOffset + offset,
        value.data.byteLength,
      ).set(value.data);

      offset += value.data.byteLength;

      return { value, nextOffset: offset };
    },

    read: (offset, view) => {
      const uint32Codec = getUint32Codec();

      const serverId = uint32Codec.readByOffset(offset, view);

      offset += uint32Codec.size;

      const clientId =
        uint32Codec.readByOffset(offset, view);

      offset += uint32Codec.size;

      const data = new Uint8Array(
        view.buffer,
        view.byteOffset + offset,
        view.byteLength - offset,
      );

      return {
        value: { serverId, clientId, data },
        nextOffset: view.byteLength,
      };
    },
  });
