// app/src/shared/types/frontend-ws-binary.ts

export interface FrontendWsTransportData {
  serverId: number;
  clientId: number;
  data: Uint8Array<ArrayBufferLike>;
}
