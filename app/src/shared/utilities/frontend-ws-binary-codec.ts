import {
  FRONTEND_WS_BINARY_HEADER_LENGTH_BYTES,
  FRONTEND_WS_BINARY_HEADER_OFFSETS,
} from '../constants/frontend-ws.js';
import type {
  FrontendWsBinaryHeader,
  FrontendWsBinaryPacket,
} from '../types/frontend-ws-binary.js';

export const encodeFrontendWsBinaryPacket = (
  header: FrontendWsBinaryHeader,
  payload: ArrayBuffer,
): ArrayBuffer => {
  const buffer = new ArrayBuffer(
    FRONTEND_WS_BINARY_HEADER_LENGTH_BYTES + payload.byteLength,
  );

  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint8(
    FRONTEND_WS_BINARY_HEADER_OFFSETS.messageType,
    header.messageType,
  );

  view.setUint32(
    FRONTEND_WS_BINARY_HEADER_OFFSETS.serverId,
    header.serverId,
    true,
  );

  view.setUint32(
    FRONTEND_WS_BINARY_HEADER_OFFSETS.clientId,
    header.clientId,
    true,
  );

  bytes.set(new Uint8Array(payload), FRONTEND_WS_BINARY_HEADER_LENGTH_BYTES);

  return buffer;
};

export const decodeFrontendWsBinaryPacket = (
  buffer: ArrayBuffer,
): FrontendWsBinaryPacket => {
  const view = new DataView(buffer);

  return {
    header: {
      messageType: view.getUint8(
        FRONTEND_WS_BINARY_HEADER_OFFSETS.messageType,
      ),
      serverId: view.getUint32(
        FRONTEND_WS_BINARY_HEADER_OFFSETS.serverId,
        true,
      ),
      clientId: view.getUint32(
        FRONTEND_WS_BINARY_HEADER_OFFSETS.clientId,
        true,
      ),
    },
    payload: buffer.slice(FRONTEND_WS_BINARY_HEADER_LENGTH_BYTES),
  };
};
