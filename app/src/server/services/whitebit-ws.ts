// src/server/services/whitebit-ws.ts
import { SECOND } from '../../shared/constants/time.js';
import type {
  MarketRollingStatistics,
} from '../../shared/types/market-statistics-rolling.js';
import type {
  MarketSnapshot,
} from '../../shared/types/market-statistics-storage.js';
import { SERVER_EVENT } from '../constants/events.js';
import type {
  MarketsInfoUpdatedEvent,
} from '../types/events.js';
import { MarketTick } from '../types/market-statistics.js';
import type {
  WhitebitMarketStatistics,
  WhitebitMarketUpdateMessage,
} from '../../shared/types/whitebit-api.js';
import { WhitebitWSClient } from '../whitebit/ws-client.js';
import { eventBus } from './event-bus.js';

const WS_REQUEST_TIMEOUT = 10 * SECOND;

const SUBSCRIBE_TYPE = {
  marketStatistics: 'market statistics',
} as const;

type SubscribeType = typeof SUBSCRIBE_TYPE[keyof typeof SUBSCRIBE_TYPE];

type SubscribeStatus =
  | 'waiting socket'
  | 'subscribing'
  | 'active'
  | 'unsubscribing';

interface SubscribePayloadByType {
  [SUBSCRIBE_TYPE.marketStatistics]: MarketsInfoUpdatedEvent['marketNames'];
}

interface SubscribeConfig {
  subscribeMethod: string;
  unsubscribeMethod: string;
}

const SUBSCRIBE_CONFIGS = {
  [SUBSCRIBE_TYPE.marketStatistics]: {
    subscribeMethod: 'market_subscribe',
    unsubscribeMethod: 'market_unsubscribe',
  },
} as const satisfies Record<SubscribeType, SubscribeConfig>;

interface SubscribeState<TPayload> {
  status: SubscribeStatus;
  requestId: number;
  payload: TPayload;
  timeout: ReturnType<typeof setTimeout> | null;
}

type SubscribeStateByType = {
  [TType in SubscribeType]: SubscribeState<SubscribePayloadByType[TType]>;
};

export class WhitebitWsService {
  private readonly wsClient = new WhitebitWSClient({
    onOpen: () => this.handleWSOpen(),
    onReconnect: () => this.handleWSReconnect(),
    onMessage: (message) => this.handleWSMessage(message),
    onError: (error) => this.handleWSError(error),
    onClose: (code, reason) => this.handleWSClose(code, reason),
  });

  private readonly subscribes = new Map<
    SubscribeType,
    SubscribeStateByType[SubscribeType]
  >();

  public start(): void {
    eventBus.on(
      SERVER_EVENT.marketsInfoUpdated,
      (event) => this.handleSubscribeEvent(
        SUBSCRIBE_TYPE.marketStatistics,
        event.marketNames,
      ),
    );

    this.wsClient.connect();
  }

  public stop(): void {
    this.clearAllSubscriptionTimeouts();
    this.wsClient.disconnect();
  }

  private handleSubscribeEvent<TType extends SubscribeType>(
    type: TType,
    payload: SubscribePayloadByType[TType],
  ): void {
    const existing = this.subscribes.get(type) as
      | SubscribeStateByType[TType]
      | undefined;

    if (!this.wsClient.isOpen()) {
      if (existing) {
        existing.payload = payload;
        existing.status = 'waiting socket';
        existing.requestId = 0;
        this.clearSubscriptionTimeout(existing);
        return;
      }

      this.subscribes.set(type, {
        status: 'waiting socket',
        requestId: 0,
        payload,
        timeout: null,
      } as SubscribeStateByType[SubscribeType]);

      return;
    }

    if (!existing) {
      this.subscribes.set(
        type,
        this.createSubscribingState(type, payload),
      );

      return;
    }

    existing.payload = payload;

    if (existing.status === 'active') {
      this.requestUnsubscribe(type, existing);
      return;
    }

    console.error('Too frequent WhiteBIT subscribe event', {
      type,
      status: existing.status,
    });

    this.wsClient.reconnect();
  }

  private handleWSOpen(): void {
    this.resubscribeAllAfterReconnect();
  }

  private handleWSReconnect(): void {
    this.resubscribeAllAfterReconnect();
  }

  private resubscribeAllAfterReconnect(): void {
    for (const [type, state] of this.subscribes) {
      this.clearSubscriptionTimeout(state);

      const requestId = this.wsClient.sendRequest(
        SUBSCRIBE_CONFIGS[type].subscribeMethod,
        state.payload,
      );

      state.status = 'subscribing';
      state.requestId = requestId;
      state.timeout = this.createSubscriptionTimeout(type, requestId);
    }
  }

  private createSubscribingState<TType extends SubscribeType>(
    type: TType,
    payload: SubscribePayloadByType[TType],
  ): SubscribeStateByType[TType] {
    const requestId = this.wsClient.sendRequest(
      SUBSCRIBE_CONFIGS[type].subscribeMethod,
      payload,
    );

    return {
      status: 'subscribing',
      requestId,
      payload,
      timeout: this.createSubscriptionTimeout(type, requestId),
    };
  }

  private requestUnsubscribe<TType extends SubscribeType>(
    type: TType,
    state: SubscribeStateByType[TType],
  ): void {
    this.clearSubscriptionTimeout(state);

    const requestId = this.wsClient.sendRequest(
      SUBSCRIBE_CONFIGS[type].unsubscribeMethod,
      [state.requestId],
    );

    state.status = 'unsubscribing';
    state.requestId = requestId;
    state.timeout = this.createSubscriptionTimeout(type, requestId);
  }

  private handleWSMessage(
    message: Record<string, unknown>,
  ): void {
    if (this.handleSubscriptionReceipt(message)) {
      return;
    }

    if (!this.isMarketUpdateMessage(message)) {
      return;
    }

    this.handleMarketUpdateMessage(message);
  }

  private handleSubscriptionReceipt(
    message: Record<string, unknown>,
  ): boolean {
    if (typeof message.id !== 'number') {
      return false;
    }

    const entry = this.findSubscribeByRequestId(message.id);

    if (!entry) {
      console.warn('Unknown WhiteBIT subscription receipt id', {
        id: message.id,
        message,
      });

      return false;
    }

    const [
      type,
      state,
    ] = entry;

    this.clearSubscriptionTimeout(state);

    if (!this.isSuccessReceipt(message)) {
      console.error('WhiteBIT subscription request failed', {
        type,
        status: state.status,
        requestId: state.requestId,
        message,
      });

      this.wsClient.reconnect();
      return true;
    }

    if (state.status === 'subscribing') {
      state.status = 'active';
      return true;
    }

    if (state.status === 'unsubscribing') {
      const requestId = this.wsClient.sendRequest(
        SUBSCRIBE_CONFIGS[type].subscribeMethod,
        state.payload,
      );

      state.status = 'subscribing';
      state.requestId = requestId;
      state.timeout = this.createSubscriptionTimeout(type, requestId);

      return true;
    }

    console.warn('Unexpected WhiteBIT subscription receipt state', {
      type,
      status: state.status,
      requestId: state.requestId,
      message,
    });

    return true;
  }

  private findSubscribeByRequestId(
    requestId: number,
  ): [SubscribeType, SubscribeStateByType[SubscribeType]] | null {
    for (const entry of this.subscribes) {
      const [
        ,
        state,
      ] = entry;

      if (state.requestId === requestId) {
        return entry;
      }
    }

    return null;
  }

  private isSuccessReceipt(
    message: Record<string, unknown>,
  ): boolean {
    if (message.error !== null) {
      return false;
    }

    if (message.result === true) {
      return true;
    }

    if (!message.result || typeof message.result !== 'object') {
      return false;
    }

    const result = message.result as Record<string, unknown>;

    return result.status === 'success';
  }

  private createSubscriptionTimeout(
    type: SubscribeType,
    requestId: number,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const state = this.subscribes.get(type);

      if (!state || state.requestId !== requestId) {
        return;
      }

      console.error('WhiteBIT subscription request timed out', {
        type,
        status: state.status,
        requestId,
      });

      this.wsClient.reconnect();
    }, WS_REQUEST_TIMEOUT);
  }

  private clearSubscriptionTimeout(
    state: SubscribeStateByType[SubscribeType],
  ): void {
    if (!state.timeout) {
      return;
    }

    clearTimeout(state.timeout);
    state.timeout = null;
  }

  private clearAllSubscriptionTimeouts(): void {
    for (const state of this.subscribes.values()) {
      this.clearSubscriptionTimeout(state);
    }
  }

  private handleMarketUpdateMessage(
    message: WhitebitMarketUpdateMessage,
  ): void {
    const [
      marketName,
      statistics,
    ] = message.params;

    const receivedAt = Date.now();
    const price = Number(statistics.last);

    if (!Number.isFinite(price)) {
      console.warn('Invalid WhiteBIT market statistics price', {
        marketName,
        last: statistics.last,
      });

      return;
    }

    const tick: MarketTick = {
      receivedAt,
      price,
    };

    const rollingStatistics = this.toRollingStatistics(
      receivedAt,
      statistics,
    );

    eventBus.emit(SERVER_EVENT.marketTickReceived, {
      marketName,
      tick,
    });

    eventBus.emit(SERVER_EVENT.marketRollingTickReceived, {
      marketName,
      rollingStatistics,
    });
  }

  private toRollingStatistics(
    receivedAt: number,
    statistics: WhitebitMarketStatistics,
  ): MarketRollingStatistics {
    return {
      receivedAt,
      open: Number(statistics.open),
      close: Number(statistics.close),
      high: Number(statistics.high),
      low: Number(statistics.low),

      stockVolume: Number(statistics.volume),
      moneyVolume: Number(statistics.deal),
    };
  }

  private isMarketUpdateMessage(
    message: Record<string, unknown>,
  ): message is WhitebitMarketUpdateMessage {
    if (message.method !== 'market_update') {
      return false;
    }

    if (!Array.isArray(message.params)) {
      return false;
    }

    if (message.params.length !== 2) {
      return false;
    }

    const [
      marketName,
      statistics,
    ] = message.params;

    return (
      typeof marketName === 'string' &&
      this.isWhitebitMarketStatistics(statistics)
    );
  }

  private isWhitebitMarketStatistics(
    value: unknown,
  ): value is WhitebitMarketStatistics {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const statistics = value as Record<string, unknown>;

    return (
      typeof statistics.period === 'number' &&
      typeof statistics.last === 'string' &&
      typeof statistics.open === 'string' &&
      typeof statistics.close === 'string' &&
      typeof statistics.high === 'string' &&
      typeof statistics.low === 'string' &&
      typeof statistics.volume === 'string' &&
      typeof statistics.deal === 'string'
    );
  }

  private handleWSError(error: Error): void {
    console.error('WhiteBIT market statistics WebSocket error', error);
  }

  private handleWSClose(
    code: number,
    reason: string,
  ): void {
    console.warn('WhiteBIT market statistics WebSocket closed', {
      code,
      reason,
    });
  }
}

export const whitebitWsService =
  new WhitebitWsService();