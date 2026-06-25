import type { Server } from 'node:http';
import {
  WebSocketServer,
  WebSocket,
} from 'ws';
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

export class AppWsServer {
  private readonly wss: WebSocketServer;

  private readonly clients = new Set<WebSocket>();
  private readonly messageHandlers = new Set<WsMessageHandler>();
  private readonly connectionHandlers = new Set<WsConnectionHandler>();

  public constructor(server: Server) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
    });

    this.wss.on('connection', (socket) => {
      this.clients.add(socket);

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
        for (const handler of this.messageHandlers) {
          try {
            handler(socket, data);
          } catch (error) {
            console.error('WS message handler failed', error);
          }
        }
      });

      socket.on('close', () => {
        this.clients.delete(socket);

        console.log('WS client disconnected', {
          clients: this.clients.size,
        });
      });

      socket.on('error', (error) => {
        console.error('WS socket error', error);
      });
    });
  }

  public onConnection(handler: WsConnectionHandler): void {
    this.connectionHandlers.add(handler);
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

  public broadcast(
    message: ServerWsJsonMessage,
  ): void {
    const payload = JSON.stringify(message);

    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      client.send(payload);
    }
  }

  public broadcastBinary(
    data: ArrayBuffer,
  ): void {
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      client.send(data);
    }
  }
}
