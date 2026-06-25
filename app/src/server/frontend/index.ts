import type { Server } from 'node:http';

import { AppWsServer } from './ws-server.js';

let wsServer: AppWsServer | null = null;

export const initWsServer = (server: Server): AppWsServer => {
  wsServer = new AppWsServer(server);

  return wsServer;
};

export const getWsServer = (): AppWsServer => {
  if (!wsServer) {
    throw new Error('WS server is not initialized');
  }

  return wsServer;
};
