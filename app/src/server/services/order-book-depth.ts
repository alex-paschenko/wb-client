// app/src/server/services/order-book-depth.ts

import { MINUTE } from '../../shared/constants/time.js';
import { SERVER_EVENT } from '../constants/events.js';
import type {
  DepthApi,
  OrderBookDepth,
  OrderBookDepthBet,
  OrderBookDepthSubscriptionParams,
  RawOrderBookDepth,
  RawOrderBookDepthBet,
} from '../types/order-book-depth.js';
import type { Strategy } from '../types/strategies.js';
import { encodeDepthHistory } from '../utilities/depth-history-codec.js';
import { eventBus } from './event-bus.js';

const MAX_SUBSCRIPTIONS = 10;
const DEPTH_LIMIT = 20;
const UNSUBSCRIBE_DELAY = MINUTE;
const RETAIN_DURATION = MINUTE;
const SAVE_INTERVAL = 5 * MINUTE;

type DepthListener = (
  strategy: Strategy,
  marketName: string,
  history: OrderBookDepth[],
) => void;

interface DepthHistory {
  subscribers: Set<Strategy>;
  orderBookDepthHistory: OrderBookDepth[];
  receivedAts: number[];
  arrivedAts: number[];
  timeoutId: ReturnType<typeof setTimeout> | null;
}

export class OrderBookDepthService {
  private readonly depthHistoryByMarkets = new Map<string, DepthHistory>();
  private readonly latestReceivedAt = new Map<string, number>();
  private readonly listeners = new Set<DepthListener>();
  private unsubscribeUpdates: (() => void) | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  public readonly api: DepthApi = {
    orderBookDepthSubscription: (params) => this.subscribe(params),
  };

  public start(): void {
    if (this.unsubscribeUpdates) {
      return;
    }

    this.unsubscribeUpdates = eventBus.on(
      SERVER_EVENT.orderBookDepthUpdate,
      (update) => this.applyDepthUpdate(update),
    );
    
    this.saveTimer = setInterval(() => this.saveOldHistory(), SAVE_INTERVAL);
  }

  public stop(): void {
    this.unsubscribeUpdates?.();
    this.unsubscribeUpdates = null;

    if (this.saveTimer) {
      clearInterval(this.saveTimer);
    }

    this.saveTimer = null;

    for (const [marketName, history] of this.depthHistoryByMarkets) {
      if (history.timeoutId) {
        clearTimeout(history.timeoutId);
      }

      this.saveHistory(marketName, history, history.receivedAts.length);

      eventBus.emit(SERVER_EVENT.orderBookDepthSubscription, {
        marketName, action: 'unsubscribe',
      });
    }

    this.depthHistoryByMarkets.clear();
  }

  public addListener(listener: DepthListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public setReceivedAt(marketName: string, receivedAt: number): void {
    this.latestReceivedAt.set(marketName, receivedAt);
  }

  public getHistory(marketName: string): OrderBookDepth[] | null {
    return this.depthHistoryByMarkets.get(marketName)
      ?.orderBookDepthHistory ?? null;
  }

  private subscribe(
    { subscription, strategy, receivedAt }: OrderBookDepthSubscriptionParams,
  ): boolean {
    const { marketName, action } = subscription;
    let history = this.depthHistoryByMarkets.get(marketName);
    this.setReceivedAt(marketName, receivedAt);

    if (action === 'subscribe') {
      if (!history) {
        if (this.depthHistoryByMarkets.size >= MAX_SUBSCRIPTIONS) {
          console.warn('Depth subscription limit reached', marketName);
          return false;
        }

        history = {
          subscribers: new Set(),
          orderBookDepthHistory: [],
          receivedAts: [],
          arrivedAts: [],
          timeoutId: null,
        };

        this.depthHistoryByMarkets.set(marketName, history);

        eventBus.emit(
          SERVER_EVENT.orderBookDepthSubscription, subscription,
        );
      } else if (history.timeoutId) {
        clearTimeout(history.timeoutId);
        history.timeoutId = null;
      }

      history.subscribers.add(strategy);
      return true;
    }

    if (!history) {
      throw new Error('Missing depth subscription for ' + marketName);
    }

    history.subscribers.delete(strategy);

    if (history.subscribers.size === 0 && !history.timeoutId) {
      history.timeoutId = setTimeout(
        () => this.finishUnsubscription(marketName),
        UNSUBSCRIBE_DELAY,
      );
    }
    return true;
  }

  private finishUnsubscription(marketName: string): void {
    const history = this.depthHistoryByMarkets.get(marketName);
    if (!history || history.subscribers.size !== 0) {
      return;
    }

    history.timeoutId = null;

    this.saveHistory(marketName, history, history.receivedAts.length);

    this.depthHistoryByMarkets.delete(marketName);

    eventBus.emit(SERVER_EVENT.orderBookDepthSubscription, {
      marketName, action: 'unsubscribe',
    });
  }

  private applyDepthUpdate(update: RawOrderBookDepth): void {
    const [isFullBody, body, marketName] = update;

    const history = this.depthHistoryByMarkets.get(marketName);
    if (!history) {
      return;
    }

    if (isFullBody && history.orderBookDepthHistory.length > 0) {
      this.saveHistory(marketName, history, history.receivedAts.length);
    }
    if (isFullBody) {
      history.orderBookDepthHistory = [];
      history.receivedAts = [];
      history.arrivedAts = [];
    }

    const previous = history.orderBookDepthHistory.at(-1);
    if (!isFullBody && !previous) {
      // The transport normally prevents this after reconnect.
      return;
    }

    const next: OrderBookDepth = {
      timestamp: body.timestamp,
      event_time: body.event_time,
      asks: isFullBody
        ? this.toSide(body.asks, 'ask')
        : this.applySide(previous!.asks, body.asks, 'ask'),
      bids: isFullBody
        ? this.toSide(body.bids, 'bid')
        : this.applySide(previous!.bids, body.bids, 'bid'),
    };

    const receivedAt = this.latestReceivedAt.get(marketName);
    if (receivedAt === undefined) {
      throw new Error('Missing tick time for depth ' + marketName);
    }

    history.orderBookDepthHistory.push(next);
    history.receivedAts.push(receivedAt);
    history.arrivedAts.push(Date.now());

    for (const strategy of history.subscribers) {
      for (const listener of this.listeners) {
        listener(strategy, marketName, history.orderBookDepthHistory);
      }
    }
  }

  private toSide(
    raw: RawOrderBookDepthBet[],
    side: 'ask' | 'bid',
  ): OrderBookDepthBet[] {
    return raw.map(
      ([price, amount]): OrderBookDepthBet =>
        [Number(price), Number(amount)],
    )
      .sort((a, b) => side === 'ask' ? a[0] - b[0] : b[0] - a[0])
      .slice(0, DEPTH_LIMIT);
  }

  private applySide(
    previous: OrderBookDepthBet[],
    changes: RawOrderBookDepthBet[],
    side: 'ask' | 'bid',
  ): OrderBookDepthBet[] {
    const next = previous.map(([price, amount]): OrderBookDepthBet =>
      [price, amount]);
    for (const [rawPrice, rawAmount] of changes) {
      const price = Number(rawPrice);
      const amount = Number(rawAmount);
      const index = next.findIndex(([level]) => level === price);

      if (index >= 0) {
        next.splice(index, 1);
      }

      if (amount !== 0) {
        next.push([price, amount]);
      }
    }
    next.sort((a, b) => side === 'ask' ? a[0] - b[0] : b[0] - a[0]);
    return next.slice(0, DEPTH_LIMIT);
  }

  private saveOldHistory(): void {
    const cutoff = Date.now() - RETAIN_DURATION;

    for (const [marketName, history] of this.depthHistoryByMarkets) {
      const count = history.arrivedAts.findIndex((at) => at > cutoff);
      const oldCount = count < 0 ? history.arrivedAts.length : count;

      if (oldCount > 0) {
        this.saveHistory(marketName, history, oldCount);
      }
    }
  }

  private saveHistory(
    marketName: string,
    history: DepthHistory,
    count: number,
  ): void {
    if (count === 0) {
      return;
    }

    const data = encodeDepthHistory(
      history.orderBookDepthHistory.slice(0, count),
    );

    eventBus.emit(
      SERVER_EVENT.depthPersistenceRequest,
      {
        marketName,
        startReceivedAt: history.receivedAts[0],
        data,
      },
    );

    history.orderBookDepthHistory.splice(0, count);
    history.receivedAts.splice(0, count);
    history.arrivedAts.splice(0, count);
  }
}

export const orderBookDepthService = new OrderBookDepthService();
