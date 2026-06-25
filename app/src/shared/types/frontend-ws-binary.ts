export type FrontendWsBinaryHeader = {
  messageType: number;
  serverId: number;
  clientId: number;
};

export type FrontendWsBinaryPacket = {
  header: FrontendWsBinaryHeader;
  payload: ArrayBuffer;
};
