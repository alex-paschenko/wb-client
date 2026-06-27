import type { Server } from 'node:http';

import {
  WebSocketServer,
  WebSocket,
} from 'ws';

import {
  FRONTEND_WS_CLIENT_PONG_TIMEOUT_MS,
  FRONTEND_WS_CONTROL_MESSAGE_TYPES,
  FRONTEND_WS_SERVER_PING_INTERVAL_MS,
} from '../../shared/constants/frontend-ws.js';
import type {
  FrontendWsClientControlMessage,
  FrontendWsClientPingMessage,
  FrontendWsClientPongMessage,
} from '../../shared/types/frontend-ws.js';
import type {
  ServerWsJsonMessage,
} from '../../shared/types/server-events.js';

type WsMessageHandler = (
  socket: WebSocket,
  data: WebSocket.RawData,
) => void;

type WsConnectionHandler = (
  socket: WebSocket,
) => void;

type WsDisconnectHandler = (
  socket: WebSocket,
) => void;

export class AppWsServer {
  private readonly wss: WebSocketServer;

  private readonly clients = new Set<WebSocket>();
  private readonly lastClientPongAtBySocket = new Map<WebSocket, number>();

  private readonly messageHandlers = new Set<WsMessageHandler>();
  private readonly connectionHandlers = new Set<WsConnectionHandler>();
  private readonly disconnectHandlers = new Set<WsDisconnectHandler>();

  private readonly serverPingIntervalId: ReturnType<typeof setInterval>;

  public constructor(server: Server) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
    });

    this.wss.on('connection', (socket) => {
      this.clients.add(socket);
      this.lastClientPongAtBySocket.set(socket, Date.now());

      console.log('WS client connected', {
        clients: this.clients.size,
      });

      for (const handler of this.connectionHandlers) {
        try {
          handler(socket);
        } catch (error) {
          console.error('WS connection handler failed', error);
        }
      }

      socket.on('message', (data) => {
        if (this.tryHandleTransportMessage(socket, data)) {
          return;
        }

        for (const handler of this.messageHandlers) {
          try {
            handler(socket, data);
          } catch (error) {
            console.error('WS message handler failed', error);
          }
        }
      });

      socket.on('close', () => {
        this.handleSocketClose(socket);
      });

      socket.on('error', (error) => {
        console.error('WS socket error', error);
      });
    });

    this.serverPingIntervalId = setInterval(() => {
      this.processServerPing();
    }, FRONTEND_WS_SERVER_PING_INTERVAL_MS);
  }

  public onConnection(handler: WsConnectionHandler): void {
    this.connectionHandlers.add(handler);
  }

  public onDisconnect(handler: WsDisconnectHandler): void {
    this.disconnectHandlers.add(handler);
  }

  public onMessage(handler: WsMessageHandler): void {
    this.messageHandlers.add(handler);
  }

  public sendJson(
    socket: WebSocket,
    message: ServerWsJsonMessage,
  ): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify(message));
  }

  public sendBinary(
    socket: WebSocket,
    data: ArrayBuffer,
  ): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(data);
  }

  public broadcast(message: ServerWsJsonMessage): void {
    const payload = JSON.stringify(message);

    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      client.send(payload);
    }
  }

  public broadcastBinary(data: ArrayBuffer): void {
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      client.send(data);
    }
  }

  private tryHandleTransportMessage(
    socket: WebSocket,
    data: WebSocket.RawData,
  ): boolean {
    const message = this.parseClientControlMessage(data);

    if (!message) {
      return false;
    }

    if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.clientPing) {
      this.handleClientPing(socket, message);
      return true;
    }

    if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.clientPong) {
      this.handleClientPong(socket, message);
      return true;
    }

    return false;
  }

  private parseClientControlMessage(
    data: WebSocket.RawData,
  ): FrontendWsClientControlMessage | null {
    let message: unknown;

    try {
      message = JSON.parse(data.toString());
    } catch {
      return null;
    }

    if (
      !message ||
      typeof message !== 'object' ||
      !('type' in message)
    ) {
      return null;
    }

    return message as FrontendWsClientControlMessage;
  }

  private handleClientPing(
    socket: WebSocket,
    message: FrontendWsClientPingMessage,
  ): void {
    this.sendJson(socket, {
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.serverPong,
      clientId: message.clientId,
      params: {
        sentAt: message.params.sentAt,
        receivedAt: Date.now(),
      },
    });
  }

  private handleClientPong(
    socket: WebSocket,
    _message: FrontendWsClientPongMessage,
  ): void {
    this.lastClientPongAtBySocket.set(socket, Date.now());
  }

  private processServerPing(): void {
    const now = Date.now();

    for (const socket of this.clients) {
      const lastClientPongAt =
        this.lastClientPongAtBySocket.get(socket) ?? 0;

      if (now - lastClientPongAt > FRONTEND_WS_CLIENT_PONG_TIMEOUT_MS) {
        socket.terminate();
        continue;
      }

      this.sendJson(socket, {
        type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.serverPing,
        serverTime: now,
      });
    }
  }

  private handleSocketClose(socket: WebSocket): void {
    for (const handler of this.disconnectHandlers) {
      try {
        handler(socket);
      } catch (error) {
        console.error('WS disconnect handler failed', error);
      }
    }

    this.lastClientPongAtBySocket.delete(socket);
    this.clients.delete(socket);

    console.log('WS client disconnected', {
      clients: this.clients.size,
    });
  }
}
