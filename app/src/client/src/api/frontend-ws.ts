import { CLIENT_VERSION } from '../../../shared/constants/client-version';
import {
  FRONTEND_WS_CLIENT_PING_INTERVAL_MS,
  FRONTEND_WS_CONTROL_MESSAGE_TYPES,
  FRONTEND_WS_RECONNECT_DELAY_MS,
  FRONTEND_WS_SERVER_PONG_TIMEOUT_MS,
} from '../../../shared/constants/frontend-ws';
import type {
  FrontendWsClientControlMessage,
  FrontendWsServerControlMessage,
  FrontendWsServerHelloMessage,
} from '../../../shared/types/frontend-ws';

type JsonMessageHandler = (
  message: FrontendWsServerControlMessage,
) => void;

type BinaryMessageHandler = (
  data: ArrayBuffer,
) => void;

type ConnectionStateHandler = (
  isConnected: boolean,
) => void;

export class FrontendWsClient {
  private socket: WebSocket | null = null;

  private pingIntervalId: number | null = null;
  private pongTimeoutId: number | null = null;
  private reconnectTimeoutId: number | null = null;

  private nextClientId = 1;
  private shouldReconnect = true;
  private isReady = false;

  private readonly jsonMessageHandlers = new Set<JsonMessageHandler>();
  private readonly binaryMessageHandlers = new Set<BinaryMessageHandler>();
  private readonly connectionStateHandlers = new Set<ConnectionStateHandler>();

  public constructor(
    private readonly url: string,
  ) {}

  public connect(): void {
    this.shouldReconnect = true;
    this.clearReconnectTimeout();

    if (
      this.socket &&
      (
        this.socket.readyState === WebSocket.CONNECTING ||
        this.socket.readyState === WebSocket.OPEN
      )
    ) {
      return;
    }

    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';

    this.socket = socket;

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) {
        return;
      }

      this.handleMessage(event.data);
    });

    socket.addEventListener('close', () => {
      this.handleClose(socket);
    });

    socket.addEventListener('error', () => {
      if (this.socket !== socket) {
        return;
      }

      socket.close();
    });
  }

  public close(): void {
    this.shouldReconnect = false;
    this.isReady = false;
    this.clearTimers();

    const socket = this.socket;
    this.socket = null;

    socket?.close();
    this.emitConnectionState(false);
  }

  public reconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }

    this.isReady = false;
    this.clearTimers();

    const socket = this.socket;
    this.socket = null;

    socket?.close();

    this.reconnectTimeoutId = window.setTimeout(() => {
      this.connect();
    }, FRONTEND_WS_RECONNECT_DELAY_MS);
  }

  public sendJson(message: FrontendWsClientControlMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(message));
  }

  public createClientId(): number {
    const clientId = this.nextClientId;
    this.nextClientId += 1;

    return clientId;
  }

  public onJsonMessage(handler: JsonMessageHandler): () => void {
    this.jsonMessageHandlers.add(handler);

    return () => {
      this.jsonMessageHandlers.delete(handler);
    };
  }

  public onBinaryMessage(handler: BinaryMessageHandler): () => void {
    this.binaryMessageHandlers.add(handler);

    return () => {
      this.binaryMessageHandlers.delete(handler);
    };
  }

  public onConnectionStateChange(
    handler: ConnectionStateHandler,
  ): () => void {
    this.connectionStateHandlers.add(handler);

    return () => {
      this.connectionStateHandlers.delete(handler);
    };
  }

  private handleMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      this.handleBinaryMessage(data);
      return;
    }

    if (typeof data === 'string') {
      this.handleJsonMessage(data);
      return;
    }

    if (data instanceof Blob) {
      void data.arrayBuffer().then((buffer) => {
        this.handleBinaryMessage(buffer);
      });
    }
  }

  private handleJsonMessage(data: string): void {
    let message: FrontendWsServerControlMessage;

    try {
      message = JSON.parse(data) as FrontendWsServerControlMessage;
    } catch {
      return;
    }

    if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.serverHello) {
      this.handleServerHello(message);
      return;
    }

    if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.serverPong) {
      this.handleServerPong();
      return;
    }

    if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.serverPing) {
      this.handleServerPing(message.serverTime);
      return;
    }

    for (const handler of this.jsonMessageHandlers) {
      handler(message);
    }
  }

  private handleServerHello(message: FrontendWsServerHelloMessage): void {
    if (message.latestClientVersion !== CLIENT_VERSION) {
      window.location.reload();
      return;
    }

    if (this.isReady) {
      return;
    }

    this.isReady = true;

    this.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.webSocketReady,
    });

    this.startPing();
    this.emitConnectionState(true);

    for (const handler of this.jsonMessageHandlers) {
      handler(message);
    }
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    for (const handler of this.binaryMessageHandlers) {
      handler(data);
    }
  }

  private startPing(): void {
    this.stopPing();

    this.pingIntervalId = window.setInterval(() => {
      this.sendClientPing();
    }, FRONTEND_WS_CLIENT_PING_INTERVAL_MS);

    this.sendClientPing();
  }

  private stopPing(): void {
    if (this.pingIntervalId !== null) {
      window.clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }

    this.clearPongTimeout();
  }

  private sendClientPing(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.clearPongTimeout();

    this.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.clientPing,
      clientId: this.createClientId(),
      params: {
        sentAt: Date.now(),
      },
    });

    this.pongTimeoutId = window.setTimeout(() => {
      this.reconnect();
    }, FRONTEND_WS_SERVER_PONG_TIMEOUT_MS);
  }

  private handleServerPing(serverTime: number): void {
    this.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.clientPong,
      clientId: this.createClientId(),
      params: {
        serverTime,
        receivedAt: Date.now(),
      },
    });
  }
  private handleServerPong(): void {
    this.clearPongTimeout();
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) {
      return;
    }

    this.socket = null;
    this.isReady = false;
    this.clearTimers();
    this.emitConnectionState(false);

    if (!this.shouldReconnect) {
      return;
    }

    this.reconnectTimeoutId = window.setTimeout(() => {
      this.connect();
    }, FRONTEND_WS_RECONNECT_DELAY_MS);
  }

  private clearTimers(): void {
    this.stopPing();
    this.clearReconnectTimeout();
  }

  private clearPongTimeout(): void {
    if (this.pongTimeoutId !== null) {
      window.clearTimeout(this.pongTimeoutId);
      this.pongTimeoutId = null;
    }
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeoutId !== null) {
      window.clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
  }

  private emitConnectionState(isConnected: boolean): void {
    for (const handler of this.connectionStateHandlers) {
      handler(isConnected);
    }
  }
}

export const frontendWsClient = new FrontendWsClient(
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
);
