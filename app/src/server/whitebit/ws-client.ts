import WebSocket from 'ws';
import { SECONDS } from '../../shared/constants/time';

export interface WhitebitWSRequest {
  id: number;
  method: string;
  params: unknown[];
}

export type WhitebitWSMessage = Record<string, unknown>;

export interface WhitebitWSClientOptions {
  url?: string;
  reconnectDelayMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

export interface WhitebitWSClientHandlers {
  onOpen?: () => void;
  onReconnect?: () => void;
  onMessage?: (message: WhitebitWSMessage) => void;
  onError?: (error: Error) => void;
  onClose?: (code: number, reason: string) => void;
}

const DEFAULT_WHITEBIT_WS_URL = 'wss://api.whitebit.com/ws';

const DEFAULT_RECONNECT_DELAY_MS = 5 * SECONDS;
const DEFAULT_PING_INTERVAL_MS = 50 * SECONDS;
const DEFAULT_PONG_TIMEOUT_MS = 10 * SECONDS;

const PING_REQUEST_ID = 0;

export class WhitebitWSClient {
  private socket: WebSocket | null = null;

  private requestId = 0;
  private shouldReconnect = false;
  private isReconnect = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly url: string;
  private readonly reconnectDelayMs: number;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;

  constructor(
    private readonly handlers: WhitebitWSClientHandlers = {},
    options: WhitebitWSClientOptions = {},
  ) {
    this.url = options.url ?? DEFAULT_WHITEBIT_WS_URL;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
  }

  connect(): void {
    this.shouldReconnect = true;
    this.clearReconnectTimer();
    this.openSocket();
  }

  public reconnect(): void {
    if (this.socket) {
      this.clearPingTimers();
      this.socket.removeAllListeners();
      this.socket.terminate();
      this.socket = null;
    }

    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.shouldReconnect = false;

    this.clearReconnectTimer();
    this.clearPingTimers();

    if (!this.socket) {
      return;
    }

    this.socket.removeAllListeners();
    this.socket.close();
    this.socket = null;
  }

  getNextRequestId(): number {
    this.requestId += 1;

    return this.requestId;
  }

  sendRequest(
    method: string,
    params: unknown[] = [],
  ): number {
    const id = this.getNextRequestId();

    this.send({
      id,
      method,
      params,
    });

    return id;
  }

  send(request: WhitebitWSRequest): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WhiteBIT WebSocket is not open');
    }

    this.socket.send(JSON.stringify(request));
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private openSocket(): void {
    this.clearPingTimers();

    const socket = new WebSocket(this.url);

    this.socket = socket;

    socket.on('open', () => {
      this.startPing();

      if (this.isReconnect) {
        this.handlers.onReconnect?.();
      } else {
        this.handlers.onOpen?.();
      }

      this.isReconnect = true;
    });

    socket.on('message', (data) => {
      this.handleRawMessage(data);
    });

    socket.on('error', (error) => {
      this.handlers.onError?.(
        error instanceof Error
          ? error
          : new Error(String(error)),
      );
    });

    socket.on('close', (code, reasonBuffer) => {
      const reason = reasonBuffer.toString();

      this.clearPingTimers();

      if (this.socket === socket) {
        this.socket = null;
      }

      this.handlers.onClose?.(code, reason);

      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });
  }

  private handleRawMessage(data: WebSocket.RawData): void {
    let message: WhitebitWSMessage;

    try {
      message = JSON.parse(data.toString()) as WhitebitWSMessage;
    } catch (error) {
      this.handlers.onError?.(
        error instanceof Error
          ? error
          : new Error(String(error)),
      );

      return;
    }

    if (this.isPong(message)) {
      this.clearPongTimer();
      return;
    }

    this.handlers.onMessage?.(message);
  }

  private startPing(): void {
    this.clearPingTimers();

    this.sendPing();

    this.pingTimer = setInterval(() => {
      this.sendPing();
    }, this.pingIntervalMs);
  }

  private sendPing(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.clearPongTimer();

    this.socket.send(JSON.stringify({
      id: PING_REQUEST_ID,
      method: 'ping',
      params: [],
    }));

    this.pongTimer = setTimeout(() => {
      this.reconnectBecausePongTimedOut();
    }, this.pongTimeoutMs);
  }

  private reconnectBecausePongTimedOut(): void {
    this.clearPingTimers();

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.terminate();
      this.socket = null;
    }

    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, this.reconnectDelayMs);
  }

  private isPong(message: WhitebitWSMessage): boolean {
    return (
      message.id === PING_REQUEST_ID &&
      message.result === 'pong' &&
      message.error === null
    );
  }

  private clearPingTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
