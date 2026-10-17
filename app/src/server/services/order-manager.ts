// app/src/server/services/order-manager.ts

import { SERVER_EVENT } from '../constants/events.js';
import type { OrderReceivedEvent } from '../types/events.js';
import type {
  OrderAndStrategy,
  OrderApi,
  OrderKind,
  OrderLimitPreRequest,
  OrderMarketPreRequest,
  OrderPrice,
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

  private readonly receivedAtByMarkets = new Map<string, number>();

  private readonly listeners = new Set<OrderListener>();

  private readonly pendingRequests = new Set<Promise<void>>();

  private stopOrderListener: (() => void) | null = null;

  public readonly api: OrderApi = {
    createMarketOrder: (strategy, request, kind) => {
      this.track(this.createOrder(strategy, request, 'market', kind));
    },

    createLimitOrder: (strategy, request, kind) => {
      this.track(this.createOrder(strategy, request, 'limit', kind));
    },

    cancelOrder: (market, id) => this.cancelOrder(market, id),

    removeAllOrdersFromCache: (strategy, market) =>
      this.removeAllOrdersFromCache(strategy, market),
  };

  public constructor(
    private readonly paperTrading = true,
  ) {}

  public start(): void {
    if (this.stopOrderListener) {
      return;
    }

    this.stopOrderListener = eventBus.on(
      SERVER_EVENT.orderReceived,
      (event) => this.handleOrderReceived(event),
    );
  }

  public stop(): void {
    this.stopOrderListener?.();
    this.stopOrderListener = null;
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
    request: OrderMarketPreRequest | OrderLimitPreRequest,
    price: OrderPrice,
    orderKind: OrderKind,
  ): Promise<void> {
    let client_order_id: number;
    try {
      client_order_id = await sequencesPersistence.getNextOrderId();
    } catch (error) {
      console.error('Order ID allocation failed unexpectedly', error);
      client_order_id = NaN;
    }
    const marketName = request.marketName;
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
    };

    orders.set(key, entry);

    if (key < 0) {
      this.recordReceipt(marketName, entry, null, {
        code: 'ORDER_ID_UNAVAILABLE',
        message: 'Cannot allocate a WhiteBIT client order ID',
      });
      for (const listener of this.listeners) listener(marketName, strategy);
      return;
    }

    const orderRequest = { ...request, client_order_id: key };
    eventBus.emit(
      price === 'market'
        ? SERVER_EVENT.createMarketOrderRequest
        : SERVER_EVENT.createLimitOrderRequest,
      { orderRequest, paperTrading: this.paperTrading },
    );
  }

  private cancelOrder(market: string, client_order_id: number): void {
    const entry = this.ordersByMarkets.get(market)?.get(client_order_id);

    if (!entry || !entry.order || entry.error) {
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
    if (owned.some(([, entry]) =>
      entry.order
        ? !isFinalOrderState(entry.order)
        : entry.error === null
    )) {
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

    if (order && (
      order.client_order_id !== client_order_id ||
      order.market !== marketName
    )) {
      throw new Error('Order receipt identity mismatch');
    }

    this.recordReceipt(marketName, entry, order, error);

    for (const listener of this.listeners) {
      listener(marketName, entry.strategy);
    }
  }

  private recordReceipt(
    marketName: string,
    entry: OrderAndStrategy,
    order: OrderAndStrategy['order'],
    error: OrderAndStrategy['error'],
  ): void {
    const receivedAt = this.receivedAtByMarkets.get(marketName);

    if (receivedAt === undefined) {
      throw new Error('Missing tick time for order ' + marketName);
    }

    const nextOrder = order ?? entry.order;
    const nextError = error;

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
