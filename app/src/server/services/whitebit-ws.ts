// src/server/services/whitebit-ws.ts

import { SECOND } from '../../shared/constants/time.js';
import type { OrderError } from '../../shared/types/order-receipt.js';
import type {
  MarketRollingStatistics,
} from '../../shared/types/market-statistics-rolling.js';
import { SERVER_EVENT } from '../constants/events.js';
import { REVERT_ORDER_ERROR } from '../constants/order-error-codes.js';
import type {
  CreateOrderRequestAndSubscribeEvent, 
  MarketDataUpdatedEvent,
  OrderBookDepthSubscriptionEvent,
} from '../types/events.js';
import type { OrderCancel } from '../types/orders.js';
import {
  fromWhitebitOrder, fromWhitebitOrderError,
  toWhitebitCancelRequest, toWhitebitOrderRequest,
} from '../whitebit/order-adapter.js';
import type { RawOrderBookDepth } from '../types/order-book-depth.js';
import { MarketTick } from '../../shared/types/ticks.js';
import type {
  WhitebitMarketStatistics,
  WhitebitMarketUpdateMessage,
} from '../../shared/types/whitebit-api.js';
import { WhitebitWSClient } from '../whitebit/ws-client.js';
import { eventBus } from './event-bus.js';
import { globalStateService } from '../../shared/services/global-state.js';

const WS_REQUEST_TIMEOUT = 10 * SECOND;
const DEPTH_LIMIT = 20;
const DEPTH_PRICE_INTERVAL = '0';

const INTERNAL_ORDER_ERRORS = {
  outcomeUnknown: {
    code: REVERT_ORDER_ERROR['order outcome unknown'], isWBError: false,
  },
  subscriptionFailed: {
    code: REVERT_ORDER_ERROR['order subscription failed'], isWBError: false,
  },
  notSent: {
    code: REVERT_ORDER_ERROR['order not sent'], isWBError: false,
  },
  realOrdersDisabled: {
    code: REVERT_ORDER_ERROR['real orders disabled'], isWBError: false,
  },
} as const satisfies Record<string, OrderError>;

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
  [SUBSCRIBE_TYPE.marketStatistics]: MarketDataUpdatedEvent['marketNames'];
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

interface DepthSubscriptionState {
  desired: boolean;
  status: SubscribeStatus;
  requestId: number;
  timeout: ReturnType<typeof setTimeout> | null;
  lastUpdateId: number | null;
}

type OrderQueueItem =
  | { kind: 'create'; event: CreateOrderRequestAndSubscribeEvent }
  | { kind: 'cancel'; event: OrderCancel };

type OrderRequestPhase =
  'subscribePending' | 'subscribeExecuted' | 'place' | 'cancel';

interface PendingOrderRequest {
  item: OrderQueueItem;
  phase: OrderRequestPhase;
  requestId: number;
  timeout: ReturnType<typeof setTimeout>;
}

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

  private readonly depthSubscriptions = new Map<string, DepthSubscriptionState>();
  private stopDepthListener: (() => void) | null = null;
  private readonly stopOrderListeners: (() => void)[] = [];
  private readonly orderQueue: OrderQueueItem[] = [];
  private pendingOrderRequest: PendingOrderRequest | null = null;
  private orderQueueBlocked = false;

  public start(): void {
    this.orderQueueBlocked = false;

    if (this.stopOrderListeners.length === 0) {
      this.stopOrderListeners.push(eventBus.on(
        SERVER_EVENT.createOrderRequestAndSubscribe,
        (event) => {
          if (!event.isPaperTrading) this.enqueueOrder({ kind: 'create', event });
        },
      ));

      this.stopOrderListeners.push(eventBus.on(
        SERVER_EVENT.orderCancelRequest,
        (event) => {
          if (!event.isPaperTrading) this.enqueueOrder({ kind: 'cancel', event });
        },
      ));
    }

    if (!this.stopDepthListener) {
      this.stopDepthListener = eventBus.on(
        SERVER_EVENT.orderBookDepthSubscription,
        (event) => this.handleDepthSubscriptionEvent(event),
      );
    }

    eventBus.on(
      SERVER_EVENT.marketDataUpdated,
      (event) => this.handleSubscribeEvent(
        SUBSCRIBE_TYPE.marketStatistics,
        event.marketNames,
      ),
    );

    const marketNames = globalStateService.getMarketNames();
    if (!marketNames) {
      throw new Error('Market Info did not loaded');
    }

    this.handleSubscribeEvent(
      SUBSCRIBE_TYPE.marketStatistics,
      marketNames,
    );

    this.wsClient.connect();
  }

  public stop(): void {
    for (const unsubscribe of this.stopOrderListeners.splice(0)) {
      unsubscribe();
    }

    this.abortOrderQueue(INTERNAL_ORDER_ERRORS.outcomeUnknown,
      'WhiteBIT service stopped');
    this.stopDepthListener?.();
    this.stopDepthListener = null;
    this.clearAllSubscriptionTimeouts();

    for (const state of this.depthSubscriptions.values()) {
      this.clearDepthTimeout(state);
    }

    this.depthSubscriptions.clear();
    this.wsClient.disconnect();
  }

  // Enable only after WebSocket account authorization and state recovery exist.
  private requireAccountAuthorization(): void {
    throw new Error('not implemented yet: WhiteBIT WebSocket authorization');
  }

  private enqueueOrder(item: OrderQueueItem): void {
    if (this.orderQueueBlocked) {
      this.reportOrderRequestResult(item, INTERNAL_ORDER_ERRORS.notSent,
        'WhiteBIT order queue requires reconciliation');
      return;
    }
    this.orderQueue.push(item);
    this.processOrderQueue();
  }

  private processOrderQueue(): void {
    if (this.pendingOrderRequest || this.orderQueueBlocked) return;
    const item = this.orderQueue.shift();
    if (!item) return;

    try {
      this.requireAccountAuthorization();
      if (!this.wsClient.isOpen()) {
        throw new Error('WhiteBIT WebSocket is not open');
      }
      if (item.kind === 'cancel') {
        this.sendOrderRequest(item, 'cancel', 'order_cancel',
          toWhitebitCancelRequest(item.event));
      } else {
        this.processCreateCommand(item);
      }
    } catch (error) {
      this.reportOrderRequestResult(item, INTERNAL_ORDER_ERRORS.realOrdersDisabled, error);
      // This command has not sent an order; it is safe to continue.
      this.processOrderQueue();
    }
  }

  private processCreateCommand(
    item: Extract<OrderQueueItem, { kind: 'create' }>,
  ): void {
    const { subscription } = item.event;
    if (subscription !== null) {
      const method = subscription.length
        ? 'ordersPending_subscribe' : 'ordersPending_unsubscribe';
      this.sendOrderRequest(item, 'subscribePending', method,
        subscription.length ? subscription : []);
      return;
    }
    this.placeOrder(item);
  }

  private placeOrder(
    item: Extract<OrderQueueItem, { kind: 'create' }>,
  ): void {
    const event = item.event;
    if (event.orderRequest === null) {
      this.processOrderQueue();
      return;
    }
    const request = toWhitebitOrderRequest(event.orderType === 'Limit'
      ? { orderType: 'Limit', orderRequest: event.orderRequest }
      : { orderType: 'Market', orderRequest: event.orderRequest });
    this.sendOrderRequest(item, 'place', request.method, request.params);
  }

  private sendOrderRequest(
    item: OrderQueueItem,
    phase: OrderRequestPhase,
    method: string,
    params: unknown[],
  ): void {
    const requestId = this.wsClient.sendRequest(method, params);
    const timeout = setTimeout(() => this.handleOrderRequestTimeout(requestId),
      WS_REQUEST_TIMEOUT);
    this.pendingOrderRequest = { item, phase, requestId, timeout };
  }

  private handleOrderRequestTimeout(requestId: number): void {
    if (this.pendingOrderRequest?.requestId !== requestId) return;
    // A placed order may have executed even when its response was lost.
    this.abortOrderQueue(INTERNAL_ORDER_ERRORS.outcomeUnknown,
      'WhiteBIT request timed out; reconcile before trading');
  }

  private handleOrderRequestReceipt(message: Record<string, unknown>): boolean {
    const pending = this.pendingOrderRequest;
    if (!pending || message.id !== pending.requestId) return false;
    clearTimeout(pending.timeout);
    this.pendingOrderRequest = null;
    const { item, phase } = pending;

    if (phase === 'subscribePending' || phase === 'subscribeExecuted') {
      if (!this.isSuccessReceipt(message)) {
        this.reportOrderRequestResult(item, INTERNAL_ORDER_ERRORS.subscriptionFailed,
          message.error ?? message.result);
        this.abortOrderQueue(INTERNAL_ORDER_ERRORS.subscriptionFailed,
          'WhiteBIT order subscription failed');
        return true;
      }
      if (item.kind === 'create') {
        try {
          if (phase === 'subscribePending') {
            const markets = item.event.subscription!;
            const method = markets.length
              ? 'ordersExecuted_subscribe' : 'ordersExecuted_unsubscribe';
            this.sendOrderRequest(item, 'subscribeExecuted', method,
              markets.length ? [markets, 0] : []);
          } else {
            this.placeOrder(item);
          }
        } catch (error) {
          this.reportOrderRequestResult(item, INTERNAL_ORDER_ERRORS.notSent, error);
          this.processOrderQueue();
        }
      }
      return true;
    }

    if (message.error != null) {
      try {
        const error = fromWhitebitOrderError(message.error);
        this.reportOrderRequestResult(item, error, message.error);
      } catch (error) {
        this.reportOrderRequestResult(item, INTERNAL_ORDER_ERRORS.outcomeUnknown,
          error);
        this.abortOrderQueue(INTERNAL_ORDER_ERRORS.outcomeUnknown,
          'Cannot decode the WhiteBIT order error');
        return true;
      }
    } else if (!message.result) {
      this.reportOrderRequestResult(item, INTERNAL_ORDER_ERRORS.outcomeUnknown,
        'WhiteBIT returned no result and no error');
      this.abortOrderQueue(INTERNAL_ORDER_ERRORS.outcomeUnknown,
        'Cannot determine whether a WhiteBIT order executed');
      return true;
    } else {
      // Order bodies in command responses are deliberately ignored.
      this.reportOrderRequestResult(item, null);
    }
    this.processOrderQueue();
    return true;
  }

  private reportOrderRequestResult(
    item: OrderQueueItem,
    error: OrderError | null,
    diagnostic?: unknown,
  ): void {
    if (diagnostic !== undefined) {
      console.error('WhiteBIT order request failed', {
        code: error?.code, isWBError: error?.isWBError, diagnostic,
      });
    }
    if (item.kind === 'create' && !item.event.orderRequest) {
      return;
    }
    const marketName = item.kind === 'cancel'
      ? item.event.market : item.event.orderRequest!.marketName;

    const client_order_id = item.kind === 'cancel'
      ? item.event.client_order_id : item.event.orderRequest!.client_order_id;
      
    eventBus.emit(SERVER_EVENT.orderRequestResult, {
      marketName,
      client_order_id,
      isPaperTrading: false,
      error,
    });
  }

  private abortOrderQueue(error: OrderError, diagnostic?: unknown): void {
    if (diagnostic !== undefined) {
      console.error('WhiteBIT order queue aborted', diagnostic);
    }
    const pending = this.pendingOrderRequest;
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingOrderRequest = null;
      this.reportOrderRequestResult(pending.item,
        pending.phase === 'place' || pending.phase === 'cancel'
          ? error : INTERNAL_ORDER_ERRORS.notSent);
    }
    for (const item of this.orderQueue.splice(0)) {
      this.reportOrderRequestResult(item, INTERNAL_ORDER_ERRORS.notSent);
    }
    // Reconnection/reconciliation will be added alongside authorization.
    this.orderQueueBlocked = true;
  }

  private handleOrdersPendingUpdate(message: Record<string, unknown>): void {
    const params = message.params;
    if (!Array.isArray(params) || params.length < 2) return;
    const [eventId, raw] = params;
    if (eventId !== 1 && eventId !== 2 && eventId !== 3) return;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const clientId = (raw as Record<string, unknown>).client_order_id;
    // Manual/account orders may have no numeric client id; they are not ours.
    if (typeof clientId !== 'number' &&
      (typeof clientId !== 'string' || !/^\d+$/.test(clientId))) {
      return;
    }
    try {
      const order = fromWhitebitOrder(raw);
      eventBus.emit(SERVER_EVENT.orderUpdated, {
        eventId,
        order,
        isPaperTrading: false,
      });
    } catch (error) {
      console.error('Malformed WhiteBIT ordersPending_update', error);
    }
  }

  private handleOrdersExecutedUpdate(message: Record<string, unknown>): void {
    const params = message.params;
    if (!Array.isArray(params) || params.length !== 1) return;
    const raw = params[0];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const clientId = (raw as Record<string, unknown>).client_order_id;
    if (typeof clientId !== 'number' &&
      (typeof clientId !== 'string' || !/^\d+$/.test(clientId))) return;

    try {
      eventBus.emit(SERVER_EVENT.orderUpdated, {
        eventId: 3,
        order: fromWhitebitOrder(raw),
        isPaperTrading: false,
      });
    } catch (error) {
      console.error('Malformed WhiteBIT ordersExecuted_update', error);
    }
  }

  private handleDepthSubscriptionEvent(
    { marketName, action }: OrderBookDepthSubscriptionEvent,
  ): void {
    const state = this.depthSubscriptions.get(marketName);
    if (!this.wsClient.isOpen()) {
      if (action === 'unsubscribe') {
        if (state) {
          this.clearDepthTimeout(state);
        }

        this.depthSubscriptions.delete(marketName);
      } else if (state) {
        this.clearDepthTimeout(state);
        state.desired = true;
        state.status = 'waiting socket';
        state.requestId = 0;
        state.lastUpdateId = null;
      } else {
        this.depthSubscriptions.set(marketName, {
          desired: true,
          status: 'waiting socket',
          requestId: 0,
          timeout: null,
          lastUpdateId: null,
        });
      }
      return;
    }

    if (action === 'subscribe') {
      if (state) {
        state.desired = true;
        if (state.status === 'waiting socket' && this.wsClient.isOpen()) {
          this.requestDepthSubscribe(marketName, state);
        }

        return;
      }

      const next: DepthSubscriptionState = {
        desired: true,
        status: 'waiting socket',
        requestId: 0,
        timeout: null,
        lastUpdateId: null,
      };

      this.depthSubscriptions.set(marketName, next);

      if (this.wsClient.isOpen()) {
        this.requestDepthSubscribe(marketName, next);
      }

      return;
    }

    if (!state) {
      return;
    }

    state.desired = false;
    state.lastUpdateId = null;

    if (state.status === 'waiting socket') {
      this.depthSubscriptions.delete(marketName);
    } else if (state.status === 'active') {
      this.requestDepthUnsubscribe(marketName, state);
    }
    // If subscribing, finish that request before sending the unsubscribe.
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

    for (const [marketName, state] of this.depthSubscriptions) {
      this.clearDepthTimeout(state);
      state.lastUpdateId = null;
      if (state.desired) {
        this.requestDepthSubscribe(marketName, state);
      } else {
        this.depthSubscriptions.delete(marketName);
      }
    }
  }

  private requestDepthSubscribe(
    marketName: string,
    state: DepthSubscriptionState,
  ): void {
    this.clearDepthTimeout(state);
    state.lastUpdateId = null;
    state.requestId = this.wsClient.sendRequest('depth_subscribe', [
      marketName, DEPTH_LIMIT, DEPTH_PRICE_INTERVAL, true,
    ]);
    state.status = 'subscribing';
    state.timeout = this.createDepthTimeout(marketName, state.requestId);
  }

  private requestDepthUnsubscribe(
    marketName: string,
    state: DepthSubscriptionState,
  ): void {
    this.clearDepthTimeout(state);
    state.lastUpdateId = null;
    state.requestId = this.wsClient.sendRequest('depth_unsubscribe', [marketName]);
    state.status = 'unsubscribing';
    state.timeout = this.createDepthTimeout(marketName, state.requestId);
  }

  private createDepthTimeout(
    marketName: string,
    requestId: number,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(
      () => {
        if (this.depthSubscriptions.get(marketName)?.requestId !== requestId) {
          return;
        }

        console.error('WhiteBIT depth subscription timed out', { marketName, requestId });
        this.wsClient.reconnect();
      },
      WS_REQUEST_TIMEOUT,
    );
  }

  private clearDepthTimeout(state: DepthSubscriptionState): void {
    if (state.timeout !== null) {
      clearTimeout(state.timeout);
    }

    state.timeout = null;
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
      [],
    );

    state.status = 'unsubscribing';
    state.requestId = requestId;
    state.timeout = this.createSubscriptionTimeout(type, requestId);
  }

  private handleWSMessage(
    message: Record<string, unknown>,
  ): void {
    if (this.handleOrderRequestReceipt(message)) {
      return;
    }

    if (message.method === 'ordersPending_update') {
      this.handleOrdersPendingUpdate(message);
      return;
    }

    if (message.method === 'ordersExecuted_update') {
      this.handleOrdersExecutedUpdate(message);
      return;
    }

    if (this.handleSubscriptionReceipt(message)) {
      return;
    }

    if (message.method === 'depth_update') {
      this.handleDepthUpdate(message);
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

    for (const [marketName, state] of this.depthSubscriptions) {
      if (state.requestId !== message.id) {
        continue;
      }

      this.clearDepthTimeout(state);

      if (!this.isSuccessReceipt(message)) {
        console.error('WhiteBIT depth subscription request failed', {
          marketName, status: state.status, message,
        });

        this.wsClient.reconnect();
      } else if (state.status === 'subscribing') {
        state.status = 'active';
        if (!state.desired) {
          this.requestDepthUnsubscribe(marketName, state);
        }

      } else if (state.status === 'unsubscribing') {
        if (state.desired) {
          this.requestDepthSubscribe(marketName, state);
        } else {
          this.depthSubscriptions.delete(marketName);
        }
      }

      return true;
    }

    const entry = this.findSubscribeByRequestId(message.id);

    if (!entry) {
      console.warn('Unknown WhiteBIT subscription receipt id', {
        id: message.id,
        message,
      });

      return false;
    }

    const [type, state] = entry;

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

  private handleDepthUpdate(message: Record<string, unknown>): void {
    const params = message.params;
    if (
      !Array.isArray(params)
      || params.length !== 3
      || (params[0] !== true && params[0] !== false)
      || typeof params[2] !== 'string'
    ) {
      return;
    }

    const state = this.depthSubscriptions.get(params[2]);

    if (
      !state
      || !state.desired
      || (state.status !== 'active' && state.status !== 'subscribing')
    ) {
      return;
    }

    const body = params[1];
    if (!body || typeof body !== 'object') {
      return;
    }

    const depthBody = body as Record<string, unknown>;
    const { update_id: updateId, past_update_id: pastUpdateId } = depthBody;

    // Either side may be omitted when it has not changed. Invalid side data
    // must not reach the book processor or advance the sequence baseline.
    if ((depthBody.asks != null && !Array.isArray(depthBody.asks)) ||
      (depthBody.bids != null && !Array.isArray(depthBody.bids))) {
      console.warn('Invalid WhiteBIT depth sides', { marketName: params[2] });
      this.requestDepthUnsubscribe(params[2], state);
      return;
    }

    if (!Number.isSafeInteger(updateId) || (updateId as number) < 0) {
      this.requestDepthUnsubscribe(params[2], state);
      return;
    }

    if (params[0] === true) {
      if (pastUpdateId !== undefined) {
        this.requestDepthUnsubscribe(params[2], state);
        return;
      }

      state.lastUpdateId = updateId as number;
    } else {
      // Ignore deltas until a full snapshot establishes a transport baseline.
      if (state.lastUpdateId === null) {
        if (state.status === 'active') {
          console.warn('WhiteBIT depth delta before snapshot', { marketName: params[2] });
          this.requestDepthUnsubscribe(params[2], state);
        }
        return;
      }
      if (pastUpdateId !== state.lastUpdateId ||
        (updateId as number) < state.lastUpdateId) {
        console.warn('WhiteBIT depth update sequence gap', {
          marketName: params[2], pastUpdateId,
          lastUpdateId: state.lastUpdateId, updateId,
        });
        this.requestDepthUnsubscribe(params[2], state);
        return;
      }
      state.lastUpdateId = updateId as number;
    }

    // Forward the exact parsed params object; consumers own all book processing.
    eventBus.emit(SERVER_EVENT.orderBookDepthUpdate, params as RawOrderBookDepth);
  }

  private findSubscribeByRequestId(
    requestId: number,
  ): [SubscribeType, SubscribeStateByType[SubscribeType]] | null {
    for (const entry of this.subscribes) {
      const [, state] = entry;

      if (state.requestId === requestId) {
        return entry;
      }
    }

    return null;
  }

  private isSuccessReceipt(
    message: Record<string, unknown>,
  ): boolean {
    if (message.error != null) {
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
    return setTimeout(
      () => {
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
      },
      WS_REQUEST_TIMEOUT,
    );
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
    const [marketName, statistics] = message.params;

    if (message.params.length > 2) {
      console.error('We are lost WS Market tick data', message.params);
    }

    const receivedAt = Date.now();
    const price = Number(statistics.last);

    if (!Number.isFinite(price)) {
      console.warn('Invalid WhiteBIT market statistics price', {
        marketName,
        last: statistics.last,
      });

      return;
    }

    const tick: MarketTick = { receivedAt, price };

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

    const [marketName, statistics] = message.params;

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

  private handleWSClose(code: number, reason: string): void {
    console.warn('WhiteBIT market statistics WebSocket closed', {
      code,
      reason,
    });

    if (this.pendingOrderRequest) {
      this.abortOrderQueue(INTERNAL_ORDER_ERRORS.outcomeUnknown,
        'WebSocket disconnected during an order request');
    }
  }
}

export const whitebitWsService = new WhitebitWsService();
