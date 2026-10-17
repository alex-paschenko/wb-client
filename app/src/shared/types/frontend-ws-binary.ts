// app/src/shared/types/frontend-ws-binary.ts

export interface FrontendWsTransportData {
  serverId: number;
  clientId: number;
  data: Uint8Array<ArrayBufferLike>;
}

export interface FrontendWsBinaryHeader {
  messageType: number;
  serverId: number;
  clientId: number;
}

export interface FrontendWsBinaryPacket {
  header: FrontendWsBinaryHeader;
  payload: Uint8Array;
}
