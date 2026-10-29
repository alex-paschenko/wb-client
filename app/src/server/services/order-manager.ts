// app/src/server/services/order-manager.ts

import type { OrderError } from '../../shared/types/order-receipt.js';
import { SERVER_EVENT } from '../constants/events.js';
import { REVERT_ORDER_ERROR } from '../constants/order-error-codes.js';
import type {
  OrderRequestResultEvent, OrderUpdatedEvent,
} from '../types/events.js';
import type {
  OrderAndStrategy, OrderApi, OrderKind, OrderCreatePreRequest,
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

  // Only real orders require an exchange subscription.
  private readonly subscribedMarkets = new Set<string>();

  private readonly receivedAtByMarkets = new Map<string, number>();

  private readonly listeners = new Set<OrderListener>();

  private readonly pendingRequests = new Set<Promise<void>>();

  private readonly stopOrderListeners: Array<() => void> = [];

  public readonly api: OrderApi = {
    createOrder: (strategy, request, kind, isPaperTrading = true) => {
      this.track(this.createOrder(strategy, request, kind, isPaperTrading));
    },

    cancelOrder: (market, id) => this.cancelOrder(market, id),

    removeAllOrdersFromCache: (strategy, market) =>
      this.removeAllOrdersFromCache(strategy, market),
  };

  public start(): void {
    if (this.stopOrderListeners.length > 0) return;

    this.stopOrderListeners.push(eventBus.on(
      SERVER_EVENT.orderRequestResult,
      event => this.handleOrderRequestResult(event),
    ));
    this.stopOrderListeners.push(eventBus.on(
      SERVER_EVENT.orderUpdated,
      event => this.handleOrderUpdated(event),
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
    strategy: Strategy<any>,
    request: OrderCreatePreRequest,
    orderKind: OrderKind,
    isPaperTrading: boolean,
  ): Promise<void> {
    const marketName = request.orderRequest.marketName;
    // Capture the decision tick before waiting for the DB sequence.
    const decisionReceivedAt = this.getReceivedAt(marketName);
    let client_order_id: number;
    try {
      client_order_id = await sequencesPersistence.getNextOrderId();
    } catch (error) {
      console.error('Order ID allocation failed unexpectedly', error);
      client_order_id = NaN;
    }

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
      isPaperTrading,
      order: null,
      error: undefined,
      isOrderUpdated: false,
      isFinalized: false,
    };

    orders.set(key, entry);
    this.recordReceipt(marketName, entry, decisionReceivedAt);

    if (key < 0) {
      entry.error = {
        code: REVERT_ORDER_ERROR['cannot allocate a WhiteBIT client order ID'],
        isWBError: false,
      };
      this.recordReceipt(marketName, entry);
      this.notify(marketName, entry);
      return;
    }

    const subscription = isPaperTrading || this.subscribedMarkets.has(marketName)
      ? null : this.addSubscribedMarket(marketName);

    // The entry exists before the event is dispatched to either executor.
    const command = request.orderType === 'Limit' ? {
      orderType: 'Limit' as const,
      orderRequest: { ...request.orderRequest, client_order_id: key },
    } : {
      orderType: 'Market' as const,
      orderRequest: { ...request.orderRequest, client_order_id: key },
    };
    eventBus.emit(SERVER_EVENT.createOrderRequestAndSubscribe, {
      ...command, subscription, isPaperTrading,
    });
  }

  private cancelOrder(market: string, client_order_id: number): void {
    const entry = this.ordersByMarkets.get(market)?.get(client_order_id);

    if (!entry || !entry.order || entry.isFinalized) {
      throw new Error('Cannot cancel an absent or finalized order');
    }

    if (entry.error === undefined) {
      throw new Error('Cannot cancel before the previous command completes');
    }

    entry.error = undefined;
    entry.isOrderUpdated = false;
    this.recordReceipt(market, entry);
    eventBus.emit(SERVER_EVENT.orderCancelRequest, {
      market, client_order_id, isPaperTrading: entry.isPaperTrading,
    });
  }

  private removeAllOrdersFromCache(strategy: Strategy, market: string): void {
    const orders = this.ordersByMarkets.get(market);
    if (!orders) {
      return;
    }

    const owned = [...orders].filter(([, entry]) => entry.strategy === strategy);
    if (owned.some(([, entry]) => !this.canRemove(entry))) {
      throw new Error('Cannot remove unresolved orders');
    }

    for (const [id] of owned) {
      orders.delete(id);
    }

    if (orders.size === 0) {
      this.ordersByMarkets.delete(market);
    }

    this.removeSubscribedMarketIfIdle(market);
  }

  private canRemove(entry: OrderAndStrategy): boolean {
    return entry.error !== undefined && (
      entry.isFinalized || (entry.order === null && entry.error !== null)
    );
  }

  private handleOrderRequestResult(event: OrderRequestResultEvent): void {
    const { marketName, client_order_id, error, isPaperTrading } = event;
    const entry = this.ordersByMarkets.get(marketName)?.get(client_order_id);
    if (!entry || entry.isPaperTrading !== isPaperTrading) {
      throw new Error('Unmatched order command result ' + client_order_id);
    }

    // Reconciliation is not implemented yet: an unknown result must not
    // masquerade as a rejection. Keep waiting until it is resolved.
    if (
      error &&
      !error.isWBError &&
      error.code === REVERT_ORDER_ERROR['order outcome unknown']
    ) {
      return;
    }

    if (entry.error !== undefined) {
      return;
    }

    entry.error = error === null ? null : { ...error };
    this.recordReceipt(marketName, entry);
    this.removeSubscribedMarketIfIdle(marketName);
    this.notify(marketName, entry);
  }

  private handleOrderUpdated(event: OrderUpdatedEvent): void {
    const { order, eventId, isPaperTrading } = event;
    const marketName = order.market;
    const entry = this.ordersByMarkets.get(marketName)
      ?.get(order.client_order_id);

    // Real account updates may refer to orders from another application.
    if (!entry || entry.isPaperTrading !== isPaperTrading) return;
    if (entry.isFinalized) return;
    if (entry.order && entry.order.mtime > order.mtime) return;
    if (entry.order && entry.order.mtime === order.mtime &&
      eventId !== 3 && !isFinalOrderState(order)) return;

    entry.order = order;
    entry.isOrderUpdated = true;
    // A partially filled Market order still awaits its finish event.
    entry.isFinalized = eventId === 3 || (
      order.status !== 'PARTIALLY_FILLED' && isFinalOrderState(order)
    );
    this.recordReceipt(marketName, entry);
    if (entry.isFinalized) this.removeSubscribedMarketIfIdle(marketName);
    this.notify(marketName, entry);
  }

  private notify(marketName: string, entry: OrderAndStrategy): void {
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
    if ([...(orders?.values() ?? [])].some(entry =>
      !entry.isPaperTrading && !this.canRemove(entry))) return;

    this.subscribedMarkets.delete(marketName);
    eventBus.emit(SERVER_EVENT.createOrderRequestAndSubscribe, {
      orderType: null,
      orderRequest: null,
      subscription: [...this.subscribedMarkets],
      isPaperTrading: false,
    });
  }

  private getReceivedAt(marketName: string): number {
    const receivedAt = this.receivedAtByMarkets.get(marketName);
    if (receivedAt === undefined) {
      throw new Error(`Missing processed tick receivedAt for ${marketName}`);
    }
    return receivedAt;
  }

  private recordReceipt(
    marketName: string,
    entry: OrderAndStrategy,
    receivedAt = this.getReceivedAt(marketName),
  ): void {
    eventBus.emit(SERVER_EVENT.orderPersistenceRequest, {
      marketName,
      receivedAt,
      client_order_id: entry.client_order_id,
      strategyName: entry.strategy.name,
      orderKind: entry.orderKind,
      isPaperTrading: entry.isPaperTrading,
      order: entry.order,
      error: entry.error,
      isOrderUpdated: entry.isOrderUpdated,
      isFinalized: entry.isFinalized,
    });
  }
}

export const orderManager = new OrderManager();
