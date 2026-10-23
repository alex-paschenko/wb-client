// app/src/server/services/order-manager.ts

import { OrderError, OrderErrorCode } from '../../shared/types/order-receipt.js';
import { SERVER_EVENT } from '../constants/events.js';
import { REVERT_ORDER_ERROR } from '../constants/order-error-codes.js';
import type { OrderReceivedEvent, OrderUpdatedEvent } from '../types/events.js';
import type {
  OrderAndStrategy,
  OrderApi,
  OrderKind,
  OrderCreatePreRequest,
} from '../types/orders.js';
import type { Strategy } from '../types/strategies.js';
import { isFinalOrderState } from '../utilities/is-final-order-state.js';
import { eventBus } from './event-bus.js';
import { sequencesPersistence } from './sequences-persistence.js';

type OrderListener = (marketName: string, strategy: Strategy) => void;

let nextLocalOrderKey = -1;

export class OrderManager {
  private readonly ordersByMarkets =
    new Map<string, Map<number, OrderAndStrategy>>();

  private readonly subscribedMarkets = new Set<string>();

  private readonly receivedAtByMarkets = new Map<string, number>();

  private readonly listeners = new Set<OrderListener>();

  private readonly pendingRequests = new Set<Promise<void>>();

  private readonly stopOrderListeners: Array<() => void> = [];

  public readonly api: OrderApi = {
    createOrder: (strategy, request, kind) => {
      this.track(this.createOrder(strategy, request, kind));
    },

    cancelOrder: (market, id) => this.cancelOrder(market, id),

    removeAllOrdersFromCache: (strategy, market) =>
      this.removeAllOrdersFromCache(strategy, market),
  };

  public constructor(
    private readonly paperTrading = true,
  ) {}

  public start(): void {
    if (this.stopOrderListeners.length > 0) return;

    this.stopOrderListeners.push(eventBus.on(
      SERVER_EVENT.orderReceived,
      (event) => this.handleOrderReceived(event),
    ));
    this.stopOrderListeners.push(eventBus.on(
      SERVER_EVENT.orderUpdated,
      (event) => this.handleOrderUpdated(event),
    ));
  }

  public stop(): void {
    for (const stop of this.stopOrderListeners.splice(0)) stop();
  }

  public async waitForPendingRequests(): Promise<void> {
    while (this.pendingRequests.size > 0) {
      await Promise.all([...this.pendingRequests]);
    }
  }

  private track(request: Promise<void>): void {
    const handled = request.catch((error: unknown) => {
      console.error('Order creation failed unexpectedly', error);
    });

    this.pendingRequests.add(handled);
    void handled.finally(() => this.pendingRequests.delete(handled));
  }

  public addListener(listener: OrderListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public setReceivedAt(marketName: string, receivedAt: number): void {
    this.receivedAtByMarkets.set(marketName, receivedAt);
  }

  public getOrdersForStrategy(
    marketName: string,
    strategy: Strategy,
  ): OrderAndStrategy[] {
    const result: OrderAndStrategy[] = [];

    for (const entry of this.ordersByMarkets.get(marketName)?.values() ?? []) {
      if (entry.strategy === strategy) result.push(entry);
    }

    return result;
  }

  private async createOrder(
    strategy: Strategy,
    request: OrderCreatePreRequest,
    orderKind: OrderKind,
  ): Promise<void> {
    let client_order_id: number;
    try {
      client_order_id = await sequencesPersistence.getNextOrderId();
    } catch (error) {
      console.error('Order ID allocation failed unexpectedly', error);
      client_order_id = NaN;
    }
    const marketName = request.orderRequest.marketName;
    let orders = this.ordersByMarkets.get(marketName);
    if (!orders) {
      orders = new Map();
      this.ordersByMarkets.set(marketName, orders);
    }

    const key = Number.isSafeInteger(client_order_id) && client_order_id > 0
      ? client_order_id
      : nextLocalOrderKey--;

    const entry: OrderAndStrategy = {
      client_order_id: key,
      strategy,
      orderKind,
      paperTrading: this.paperTrading,
      order: null,
      error: null,
      isFinalized: false,
    };

    orders.set(key, entry);

    if (key < 0) {
      entry.isFinalized = true;
      this.recordReceipt(marketName, entry, null, {
        code: REVERT_ORDER_ERROR['cannot allocate a WhiteBIT client order ID'],
        isWBError: false,
      });
      for (const listener of this.listeners) listener(marketName, strategy);
      return;
    }

    const subscription = this.subscribedMarkets.has(marketName)
      ? null
      : this.addSubscribedMarket(marketName);

    // No await between registration, subscription update and event dispatch.
    const command = request.orderType === 'Limit' ? {
      orderType: 'Limit' as const,
      orderRequest: { ...request.orderRequest, client_order_id: key },
    } : {
      orderType: 'Market' as const,
      orderRequest: { ...request.orderRequest, client_order_id: key },
    };
    eventBus.emit(SERVER_EVENT.createOrderRequestAndSubscribe, {
      ...command, subscription, paperTrading: this.paperTrading,
    });
  }

  private cancelOrder(market: string, client_order_id: number): void {
    const entry = this.ordersByMarkets.get(market)?.get(client_order_id);

    if (!entry || !entry.order || entry.isFinalized) {
      throw new Error('Cannot cancel an absent or failed order');
    }
    eventBus.emit(SERVER_EVENT.orderCancelRequest, {
      market, client_order_id, paperTrading: entry.paperTrading,
    });
  }

  private removeAllOrdersFromCache(
    strategy: Strategy,
    market: string,
  ): void {
    const orders = this.ordersByMarkets.get(market);
    if (!orders) return;
    const owned = [...orders].filter(([, entry]) =>
      entry.strategy === strategy);
    if (owned.some(([, entry]) => !entry.isFinalized)) {
      throw new Error('Cannot remove orders before they finish');
    }

    for (const [id] of owned) {
      orders.delete(id);
    }

    if (orders.size === 0) this.ordersByMarkets.delete(market);
  }

  private handleOrderReceived(event: OrderReceivedEvent): void {
    const { marketName, client_order_id, order, error, paperTrading } = event;
    const entry = this.ordersByMarkets.get(marketName)?.get(client_order_id);

    if (!entry) {
      throw new Error('Unmatched order receipt ' + client_order_id);
    }

    if (entry.paperTrading !== paperTrading) {
      throw new Error('Order receipt trading mode mismatch');
    }

    if (
      order &&
      (order.client_order_id !== client_order_id || order.market !== marketName)
    ) {
      throw new Error('Order receipt identity mismatch');
    }

    // Responses to a create/cancel call can arrive after subscription updates.
    if (entry.isFinalized) {
      return;
    }

    if (order && entry.order && entry.order.mtime >= order.mtime) {
      return;
    }

    // Errors on cancellation must not terminate an existing live order.
    const isFinalized = order
      ? isFinalOrderState(order)
      : !entry.order && error !== null && !this.isUnknownOutcome(error);

    this.acceptReceipt(
      marketName,
      entry,
      order,
      error,
      isFinalized,
    );
  }

  private handleOrderUpdated(event: OrderUpdatedEvent): void {
    const { order, eventId, paperTrading } = event;
    const marketName = order.market;
    const entry = this.ordersByMarkets.get(marketName)
      ?.get(order.client_order_id);

    // Account subscriptions also include orders belonging to other clients.
    if (!entry || entry.paperTrading !== paperTrading) {
      return;
    }

    if (entry.isFinalized) {
      return;
    }

    if (entry.order && entry.order.mtime >= order.mtime) {
      return;
    }

    this.acceptReceipt(marketName, entry, order, null, eventId === 3);
  }

  private isUnknownOutcome(error: OrderError): boolean {
    return !error.isWBError &&
      error.code === REVERT_ORDER_ERROR['order outcome unknown'];
  }

  private acceptReceipt(
    marketName: string,
    entry: OrderAndStrategy,
    order: OrderAndStrategy['order'],
    error: { code: OrderErrorCode, isWBError: boolean } | null,
    isFinalized: boolean,
  ): void {
    this.recordReceipt(marketName, entry, order, error);

    if (isFinalized) {
      entry.isFinalized = true;
      this.removeSubscribedMarketIfIdle(marketName);
    }

    for (const listener of this.listeners) {
      listener(marketName, entry.strategy);
    }
  }

  private addSubscribedMarket(marketName: string): string[] {
    this.subscribedMarkets.add(marketName);
    return [...this.subscribedMarkets];
  }

  private removeSubscribedMarketIfIdle(marketName: string): void {
    if (!this.subscribedMarkets.has(marketName)) return;
    const orders = this.ordersByMarkets.get(marketName);
    if ([...(orders?.values() ?? [])].some(entry => !entry.isFinalized)) {
      return;
    }

    this.subscribedMarkets.delete(marketName);
    eventBus.emit(SERVER_EVENT.createOrderRequestAndSubscribe, {
      orderType: null,
      orderRequest: null,
      subscription: [...this.subscribedMarkets],
      paperTrading: this.paperTrading,
    });
  }

  private recordReceipt(
    marketName: string,
    entry: OrderAndStrategy,
    order: OrderAndStrategy['order'],
    error: { code: OrderErrorCode, isWBError: boolean } | null,
  ): void {
    const receivedAt = this.receivedAtByMarkets.get(marketName);

    if (receivedAt === undefined) {
      throw new Error('Missing tick time for order ' + marketName);
    }

    const nextOrder = order ?? entry.order;
    const nextError: OrderError | null = error === null
      ? null
      : {
          code: error.code,
          isWBError: error.isWBError,
        };

    eventBus.emit(SERVER_EVENT.orderPersistenceRequest, {
      marketName,
      receivedAt,
      client_order_id: entry.client_order_id,
      strategyName: entry.strategy.name,
      orderKind: entry.orderKind,
      paperTrading: entry.paperTrading,
      order: nextOrder,
      error: nextError,
    });

    entry.order = nextOrder;
    entry.error = nextError;
  }
}

export const orderManager = new OrderManager();
