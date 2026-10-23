// app/src/server/strategies/one-market-two-deals.ts

import type { OrderAndStrategy, OrderApi } from '../types/orders.js';
import type {
  OneMarketTwoDealsStrategyState,
  Strategy,
  StrategyDirection,
  StrategyStates,
  StrategyRunParams,
  StrategyStorage,
} from '../types/strategies.js';
import { REVERT_ORDER_ERROR } from '../constants/order-error-codes.js';
import { BaseStrategy } from './base-strategy.js';
import { OrderErrorCode } from '../../shared/types/order-receipt.js';

const FATAL_ERRORS: Set<OrderErrorCode> = new Set([
  REVERT_ORDER_ERROR['trading in the market is not allowed'],
]);

interface OneMarketTwoDealsParams {
  longCandidateTreshold: number;
  shortCandidateTreshold: number;
  longReturnToIdleTreshold: number;
  shortReturnToIdleTreshold: number;
  longOpenDealTreshold: number;
  shortOpenDealTreshold: number;
  longCloseDealTreshold: number;
  shortCloseDealTreshold: number;
}

interface ManageOrdersParams {
    orderApi: OrderApi,
    marketName: string,
    dealDirection: StrategyDirection,
    orders: OrderAndStrategy[],
    storage: StrategyStorage[];
}

export class OneMarketTwoDeals extends BaseStrategy<OneMarketTwoDealsStrategyState> {
  private params: OneMarketTwoDealsParams;

  private direction: Map<string, StrategyDirection> = new Map();

  private dealAmount: Map<string, number> = new Map();

  public constructor(params: OneMarketTwoDealsParams) {
    const name = 'm1d2:' + Object.values(params).join('-');
    super(name);

    this.params = params;
  }

  exec(
    params: StrategyRunParams<OneMarketTwoDealsStrategyState>,
  ): StrategyStates<OneMarketTwoDealsStrategyState> {
    const { storage, depthApi, depthHistory, orderApi, orders, stateChanges } = params;

    const lastStorage = storage[storage.length - 1];
    const { forecast, receivedAt, marketName } = lastStorage;

    const state = stateChanges.at(-1)?.state ?? 'idle';

    const expectedCombined = forecast.expectedResidual1mCombined;

    switch(state) {
      case 'idle': {
        if (
          expectedCombined !== null &&
          (expectedCombined > this.params.longCandidateTreshold ||
            expectedCombined < this.params.shortCandidateTreshold)
        ) {
          this.direction.set(marketName, expectedCombined > 0 ? 'long' : 'short');

          const subscribed = depthApi.orderBookDepthSubscription({
            subscription: { marketName, action: 'subscribe' },
            strategy: this as Strategy<string>,
            receivedAt,
          });

          if (subscribed) {
            return { state: 'candidate', action: 'continue' };
          }
        }

        return { state, action: 'stop' };
      }

      case 'candidate': {
        const dealDirection = this.getDealDirection(marketName);

        if (
          expectedCombined === null ||
          dealDirection === 'long' && expectedCombined < this.params.longReturnToIdleTreshold ||
          dealDirection === 'short' && expectedCombined > this.params.shortReturnToIdleTreshold
        ) {
          return { state: 'unsubscribe and switch to idle', action: 'continue' };
        }

        if (
          dealDirection === 'long' && expectedCombined >= this.params.longOpenDealTreshold ||
          dealDirection === 'short' && expectedCombined <= this.params.shortOpenDealTreshold
        ) {
          return { state: 'awaiting for order book depth data', action: 'stop' };
        }

        return { state, action: 'stop' };
      }

      case 'awaiting for order book depth data':
        if (depthHistory && depthHistory.length > 0) {
          const dealDirection = this.getDealDirection(marketName);

          this.manageOrdersToOpenDeal(
            { orderApi, marketName, orders, dealDirection, storage },
          );

          return { state: 'awaiting for first main order creation', action: 'continue' };
        }

        return { state, action: 'stop' };

      case 'awaiting for first main order creation': {
        const mainEntry = orders.find((o) => o.orderKind === 'main');

        if (!mainEntry || !mainEntry.isFinalized) {
          return { state, action: 'stop' };
        }

        if (mainEntry.error) {
          orderApi.removeAllOrdersFromCache(
            this as Strategy<string>, marketName,
          );
          return {
            state: 'unsubscribe and switch to idle',
            action: 'continue',
          };
        }

        if (!mainEntry.order || mainEntry.order.deal_stock <= 0) {
          // A finalized order may have no actual execution.
          orderApi.removeAllOrdersFromCache(
            this as Strategy<string>, marketName,
          );
          return { state: 'unsubscribe and switch to idle', action: 'continue' };
        }

        return { state: 'holding', action: 'continue' };
      }

      case 'holding': {
        const dealDirection = this.getDealDirection(marketName);

        if (
          expectedCombined === null ||
          dealDirection === 'long' && expectedCombined <= this.params.longCloseDealTreshold ||
          dealDirection === 'short' && expectedCombined >= this.params.shortCloseDealTreshold
        ) {
          const result = this.manageOrdersToCloseDeal(
            { orderApi, marketName, orders, dealDirection, storage },
          );

          return result === 'order created'
            ? { state: 'awaiting for second main order creation', action: 'stop' }
            : { state: 'unsubscribe and switch to idle', action: 'continue' };
        }

        return { state, action: 'stop' };
      }

      case 'awaiting for second main order creation': {
        const dealDirection = this.getDealDirection(marketName);

        return this.manageAdditionalOrdersToCloseDeal(
          { orderApi, marketName, orders, dealDirection, storage },
        ) === 'deal closed'
          ? { state: 'unsubscribe and switch to idle', action: 'continue' }
          : { state, action: 'stop' };
      }

      case 'unsubscribe and switch to idle': {
        depthApi.orderBookDepthSubscription({
          subscription: { marketName, action: 'unsubscribe' },
          strategy: this as Strategy<string>,
          receivedAt,
        });

        this.direction.delete(marketName);

        return { state: 'idle', action: 'stop' };
      }

      default:
        throw new Error(`Unknown state "${state}"`);
    }
  }

  private manageOrdersToOpenDeal({
    orderApi,
    marketName,
    orders,
    dealDirection,
    storage,
  }: ManageOrdersParams): void {
    // TODO: replace it after switch to real trading.
    const amount = dealDirection === 'long' ? 1000 : 1000 / storage.at(-1)!.price;

    if (orders.length > 0) {
      throw new Error(`Uncompleted old orders found.`);
    }

    orderApi.createOrder(
      this as Strategy<string>,
      {
        orderType: 'Market',
        orderRequest: {
          marketName, side: dealDirection === 'long' ? 'buy' : 'sell', amount,
        },
      },
      'main',
    );
  }

  private manageOrdersToCloseDeal({
    orderApi,
    marketName,
    orders,
    dealDirection,
  }: ManageOrdersParams): 'order created' | 'without new order' {
    const { order } = this.getMainOrderEntry(orders);

    orderApi.removeAllOrdersFromCache(this as Strategy<string>, marketName);

    if (order) {
      // TODO: For real orders, we'll need also to compare our balance
      // with Market.minAmount and replace this amount calculation.
      const amount = dealDirection == 'long'
        ? order.deal_stock
        : order.deal_money

      if (amount > 0) {
        this.dealAmount.set(marketName, amount);

        orderApi.createOrder(
          this as Strategy<string>,
          {
            orderType: 'Market',
            orderRequest: {
              marketName,
              side: dealDirection === 'long' ? 'sell' : 'buy',
              amount,
            },
          },
          'main',
        );

        return 'order created';
      }
    }

    return 'without new order';
  }

    private manageAdditionalOrdersToCloseDeal({
    orderApi,
    marketName,
    orders,
    dealDirection,
  }: ManageOrdersParams): 'deal closed' | 'has rest' | 'fatal error' {
    const mainEntry = orders.find((o) => o.orderKind === 'main');
    if (!mainEntry) {
      return 'has rest';
    }

    if (mainEntry.isFinalized && mainEntry.order || mainEntry.error) {
      if (mainEntry.error && FATAL_ERRORS.has(mainEntry.error.code)) {}

      const prevAmount = this.dealAmount.get(marketName);
      if (!prevAmount) {
        throw new Error(`Prev. amount not found.`);
      }

      const amount = prevAmount - (
        dealDirection === 'long'
        ? mainEntry.order?.deal_stock ?? 0
        : mainEntry.order?.deal_money ?? 0
      );

      orderApi.removeAllOrdersFromCache(this as Strategy<string>, marketName);

      if (amount > 0) {
        this.dealAmount.set(marketName, amount);

        orderApi.createOrder(
          this as Strategy<string>,
          {
            orderType: 'Market',
            orderRequest: {
              marketName,
              side: dealDirection === 'long' ? 'sell' : 'buy',
              amount,
            },
          },
          'main',
        );

        return 'has rest';
      }
    }

    return 'has rest';
  }

  private getMainOrderEntry(orders: OrderAndStrategy[]): OrderAndStrategy {
    const mainOrderEntry = orders.find((o) => o.orderKind === 'main');
    if (!mainOrderEntry) {
      throw new Error(`Main order entry not found.`);
    }

    return mainOrderEntry;
  }

  getDealDirection(marketName: string): StrategyDirection {
    const dealDirection = this.direction.get(marketName);

    if (!dealDirection) {
      throw new Error(`Missing strategy direction.`);
    }

    return dealDirection;
  }
}
