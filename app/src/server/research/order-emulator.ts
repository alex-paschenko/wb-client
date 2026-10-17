// app/src/server/research/order-emulator.ts

import { globalStateService } from '../../shared/services/global-state.js';
import type { Order } from '../../shared/types/order-receipt.js';
import { SERVER_EVENT } from '../constants/events.js';
import type {
  OrderCancel,
  OrderLimitRequest,
  OrderMarketRequest,
} from '../types/orders.js';
import { eventBus } from '../services/event-bus.js';
import { orderBookDepthService } from '../services/order-book-depth.js';
import { SECOND } from '../../shared/constants/time.js';

const RESPONSE_DELAY_MS = 50;
const EPSILON = 1e-10;

export class OrderEmulator {
  private readonly active = new Map<number, Order>();
  private readonly timers =
    new Map<ReturnType<typeof setTimeout>, () => void>();
  private readonly unsubscribe: (() => void)[] = [];

  public start(): void {
    if (this.unsubscribe.length > 0) {
      return;
    }

    this.unsubscribe.push(eventBus.on(
      SERVER_EVENT.createMarketOrderRequest,
      (event) => {
        if (event.paperTrading) {
          this.defer(() => this.create(event.orderRequest, true));
        }
      },
    ));

    this.unsubscribe.push(eventBus.on(
      SERVER_EVENT.createLimitOrderRequest,
      (event) => {
        if (event.paperTrading) {
          this.defer(() => this.create(event.orderRequest, false));
        }
      },
    ));

    this.unsubscribe.push(eventBus.on(
      SERVER_EVENT.orderCancelRequest,
      (event) => {
        if (event.paperTrading) {
          this.defer(() => this.cancel(event));
        }
      },
    ));
  }

  public stop(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) {
      unsubscribe();
    }

    for (const [timer, callback] of this.timers) {
      clearTimeout(timer);
      callback();
    }

    this.timers.clear();
  }

  private defer(callback: () => void): void {
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        callback();
      },
      RESPONSE_DELAY_MS,
    );

    this.timers.set(timer, callback);
  }

  private create(
    request: OrderMarketRequest | OrderLimitRequest,
    isMarket: boolean,
  ): void {
    const { marketName, client_order_id, side } = request;

    const amount = Number(request.amount);

    const book = orderBookDepthService.getHistory(marketName)?.at(-1);
    if (!book || !Number.isFinite(amount) || amount <= 0) {
      this.reportError(
        marketName, client_order_id,
        'DEPTH_UNAVAILABLE',
        'Paper order needs a current book and a positive amount',
      );
      return;
    }

    const limitPrice = isMarket
      ? null
      : (request as OrderLimitRequest).price;

    if (limitPrice !== null && (
      !Number.isFinite(limitPrice) || limitPrice <= 0
    )) {
      this.reportError(
        marketName, client_order_id,
        'INVALID_PRICE',
        'Paper limit price must be positive',
      );

      return;
    }

    let left = amount;
    let deal_stock = 0;
    let deal_money = 0;
    const sideToTake = side === 'buy' ? book.asks : book.bids;

    for (const [price, available] of sideToTake) {
      if (
        limitPrice !== null &&
        (side === 'buy' ? price > limitPrice : price < limitPrice)
      ) {
        break;
      }

      if (left <= EPSILON) {
        break;
      }

      const matched = isMarket && side === 'buy'
        ? Math.min(available, left / price)
        : Math.min(available, left);

      if (matched <= 0) {
        continue;
      }

      deal_stock += matched;
      deal_money += matched * price;
      left -= isMarket && side === 'buy'
        ? matched * price
        : matched;
    }

    left = Math.max(0, left);

    if (isMarket && deal_stock <= 0) {
      this.reportError(
        marketName, client_order_id,
        'NO_LIQUIDITY',
        'No executable paper order book levels',
      );

      return;
    }

    const now = Date.now() / SECOND;

    const feeRate = Number(
      globalStateService.getMarketsOrNull()?.[marketName]?.takerFee ?? 0,
    );

    const status = left <= EPSILON
      ? 'FILLED'
      : deal_stock > 0 ? 'PARTIALLY_FILLED' : 'OPEN';

    const order: Order = {
      id: client_order_id,
      client_order_id,
      market: marketName,
      type: isMarket ? 'Market' : 'Limit',
      side,
      status: status === 'OPEN' && isMarket
        ? 'PARTIALLY_FILLED'
        : status,
      amount,
      left,
      deal_stock,
      deal_money,
      deal_fee: deal_money * (Number.isFinite(feeRate) ? feeRate : 0),
      price: limitPrice ?? 0,
      ctime: now,
      mtime: now,
      post_only: false,
      ioc: false,
      stp: 'no',
      position_side: 'BOTH',
      rpi: false,
      retail: false,
      reduce_only: false,
    };

    if (!isMarket && status !== 'FILLED') {
      this.active.set(client_order_id, order);
    }

    eventBus.emit(
      SERVER_EVENT.orderReceived,
      {
        marketName, client_order_id, paperTrading: true,
        order, error: null,
      },
    );
  }

  private cancel({ market, client_order_id }: OrderCancel): void {
    const existing = this.active.get(client_order_id);
    if (!existing || existing.market !== market) {
      this.reportError(
        market, client_order_id,
        'ORDER_NOT_ACTIVE', 'Paper order is no longer active',
      );

      return;
    }

    this.active.delete(client_order_id);

    eventBus.emit(
      SERVER_EVENT.orderReceived,
      {
        marketName: market,
        client_order_id,
        paperTrading: true,
        order: { ...existing, mtime: Date.now() / 1000, status: 'CANCELED' },
        error: null,
      },
    );
  }

  private reportError(
    marketName: string,
    client_order_id: number,
    code: string,
    message: string,
  ): void {
    eventBus.emit(
      SERVER_EVENT.orderReceived,
      {
        marketName, client_order_id,
        paperTrading: true,
        order: null,
        error: { code, message },
      },
    );
  }
}

export const orderEmulator = new OrderEmulator();
