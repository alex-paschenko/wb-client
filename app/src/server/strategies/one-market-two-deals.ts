// app/src/server/strategies/one-market-two-deals.ts

import type { OrderAndStrategy, OrderApi } from '../types/orders.js';
import type {
  OneMarketTwoDealsStrategyState,
  Strategy,
  StrategyDirection,
  StrategyStates,
  StrategyRests,
  StrategyRunParams,
  StrategyStorage,
} from '../types/strategies.js';
import { REVERT_ORDER_ERROR } from '../constants/order-error-codes.js';
import { BaseStrategy } from './base-strategy.js';
import { OrderErrorCode } from '../../shared/types/order-receipt.js';
import { IndicatorValue } from '../../shared/types/data-types.js';
import { globalStateService } from '../../shared/services/global-state.js';
import { MarketFee } from '../../shared/types/market.js';

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

interface ContinueSecondDealParams {
    orderApi: OrderApi,
    dealMoney: number,
    dealStock: number,
    marketName: string,
}

type ManageOrdersRetType =
  | 'awaiting'
  | 'order created'
  | 'without new order'
  | 'fatal error';

export class OneMarketTwoDeals extends BaseStrategy<OneMarketTwoDealsStrategyState> {
  private isPaperTrading = true;

  private params: OneMarketTwoDealsParams;

  private direction: Map<string, StrategyDirection> = new Map();

  public constructor(params: OneMarketTwoDealsParams) {
    const name = 'stock1m2d:' + Object.values(params).join('-');
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
        if (!this.isMarketRestricted(marketName, 'spot')) {
          return { state, action: 'stop', kind: 'bare' };
        }

        if (
          expectedCombined !== null &&
          (expectedCombined > this.params.longCandidateTreshold ||
            expectedCombined < this.params.shortCandidateTreshold)
        ) {
          this.direction.set(
            marketName,
            expectedCombined > 0 ? 'long' : 'short',
          );

          const subscribed = depthApi.orderBookDepthSubscription({
            subscription: { marketName, action: 'subscribe' },
            strategy: this as Strategy<string>,
            receivedAt,
          });

          if (subscribed) {
            return { state: 'candidate', action: 'continue', kind: 'bare' };
          }
        }

        return { state, action: 'stop', kind: 'bare' };
      }

      case 'candidate': {
        const result = this.checkOpenDealTresholds(expectedCombined, marketName);

        if (result === 'cancel') {
          return {
            state: 'unsubscribe and switch to idle',
            action: 'continue',
            kind: 'bare',
          };
        }

        return {
          state: 'awaiting for order book depth data',
          action: 'stop',
          kind: 'bare',
        };
      }

      case 'awaiting for order book depth data':
        const result = this.checkOpenDealTresholds(expectedCombined, marketName);

        if (result === 'cancel') {
          return {
            state: 'unsubscribe and switch to idle',
            action: 'continue',
            kind: 'bare',
          };
        }

        if (result === 'start deal' && depthHistory && depthHistory.length > 0) {
          const isLong = this.isDirectionLong(marketName);

          if (orders.length > 0) {
            throw new Error(`Uncompleted old orders found.`);
          }

          // TODO: replace it after switch to real trading.
          const amount = isLong ? 1000 : 1000 / lastStorage.price;

          const newRests = isLong
            ? { money: amount, stock: 0 }
            : { money: 0, stock: amount };

          this.rests.set(marketName, newRests);

          orderApi.createOrder(
            this as Strategy<string>,
            {
              orderType: 'Market',
              orderRequest: {
                marketName,
                side: isLong ? 'buy' : 'sell',
                amount,
              },
            },
            'main',
            this.isPaperTrading,
          );

          return {
            state: 'awaiting for first main order creation',
            action: 'stop',
            kind: 'rests',
            ...newRests,
          };
        }

        return { state, action: 'stop', kind: 'bare' };

      case 'awaiting for first main order creation': {
        const isLong = this.isDirectionLong(marketName);

        const mainEntry = orders.find((o) => o.orderKind === 'main');
        if (!this.isOrderCommandCompleted(mainEntry)) {
          return {
            state,
            action: 'stop',
            kind: 'rests',
            ...this.getRests(marketName),
          };
        }

        // If we receive an error when creating an order,
        // it means the order will not be created.
        if (mainEntry.error) {
          orderApi.removeAllOrdersFromCache(this, marketName);

          const errorCode = mainEntry.error.code;

          return FATAL_ERRORS.has(errorCode)
            ? {
                state: 'unsubscribe and switch to idle',
                action: 'continue',
                kind: 'error',
                errorCode,
              }
            : {
                state: 'candidate',
                action: 'stop',
                kind: 'error',
                errorCode,
              };

        }

        if (!mainEntry.isOrderUpdated || !mainEntry.isFinalized) {
          return {
            state,
            action: 'stop',
            kind: 'rests',
            ...this.getRests(marketName),
          };
        }

        orderApi.removeAllOrdersFromCache(this, marketName);

        if (!mainEntry.order) {
          console.error(`Did not received neither order nor error`);

          return {
            state: 'unsubscribe and switch to idle',
            action: 'stop',
            kind: 'error',
            errorCode:
              REVERT_ORDER_ERROR['did not received neither order nor error'],
          };
        }

        const fee = this.getTakerFee(marketName);

        const rests = this.getRests(marketName);
        const newRests = isLong
          ? {
              money: rests.money - mainEntry.order.deal_money,
              stock: rests.stock + mainEntry.order.deal_stock * fee,
            }
          : {
              stock: rests.stock - mainEntry.order.deal_stock,
              money: rests.money + mainEntry.order.deal_money * fee,
            };

        this.rests.set(marketName, newRests);

        // A finalized order may have no actual execution.
        if (mainEntry.order.deal_stock <= 0) {
          return {
            state: 'unsubscribe and switch to idle',
            action: 'continue',
            kind: 'rests',
            ...newRests,
          };
        }

        return {
          state: 'holding',
          action: 'continue',
          kind: 'rests',
          ...newRests,
        };
      }

      case 'holding': {
        const isLong = this.isDirectionLong(marketName);
        const rests = this.getRests(marketName);

        if (
          expectedCombined === null ||
          isLong && expectedCombined <= this.params.longCloseDealTreshold ||
          !isLong && expectedCombined >= this.params.shortCloseDealTreshold
        ) {
          const amount = isLong ? rests.stock : rests.money;
          if (amount <= 0) {
            return {
              state: 'unsubscribe and switch to idle',
              action: 'continue',
              kind: 'error',
              errorCode: REVERT_ORDER_ERROR['unexpected zero rest'],
            }
          }

          orderApi.createOrder(
            this,
            {
              orderType: 'Market',
              orderRequest: {
                marketName,
                side: isLong ? 'sell' : 'buy',
                amount,
              },
            },
            'main',
            this.isPaperTrading,
          );

          return {
            state: 'awaiting for second main order creation',
            action: 'stop',
            kind: 'rests',
            ...rests,
          };
        }

        return { state, action: 'stop', kind: 'rests', ...rests };
      }

      case 'awaiting for second main order creation': {
        const isLong = this.isDirectionLong(marketName);

        const mainEntry = orders.find((o) => o.orderKind === 'main');
        if (!this.isOrderCommandCompleted(mainEntry)) {
          return {
            state,
            action: 'stop',
            kind: 'rests',
            ...this.getRests(marketName),
          };
        }

        // If we receive an error when creating an order,
        // it means the order will not be created.
        if (mainEntry.error) {
          orderApi.removeAllOrdersFromCache(this, marketName);

          const errorCode = mainEntry.error.code;

          return FATAL_ERRORS.has(errorCode)
            ? {
                state: 'unsubscribe and switch to idle',
                action: 'continue',
                kind: 'error',
                errorCode,
              }
            : {
                state: 'holding',
                action: 'stop',
                kind: 'error',
                errorCode,
              };

        }

        if (!mainEntry.isOrderUpdated || !mainEntry.isFinalized) {
          return {
            state,
            action: 'stop',
            kind: 'rests',
            ...this.getRests(marketName),
          };
        }

        orderApi.removeAllOrdersFromCache(this, marketName);

        const order = mainEntry.order;
        if (!order) {
          console.error(`Did not received neither order nor error`);

          return {
            state: 'holding',
            action: 'stop',
            kind: 'error',
            errorCode:
              REVERT_ORDER_ERROR['did not received neither order nor error'],
          };
        }

        const fee = this.getTakerFee(marketName);

        const rests = this.getRests(marketName);
        const newRests: StrategyRests = {
          money: isLong
            ? rests.money + order.deal_money * fee
            : rests.money - order.deal_money,
          stock: isLong
            ? rests.stock - order.deal_stock
            : rests.stock + order.deal_stock * fee,
        };

        this.rests.set(marketName, newRests);
        const amount = isLong ? newRests.stock : newRests.money;

        if (amount <=0) {
          return {
            state:'unsubscribe and switch to idle',
            action: 'continue',
            kind: 'rests',
            ...newRests,
          }
        }

        orderApi.createOrder(
          this as Strategy<string>,
          {
            orderType: 'Market',
            orderRequest: {
              marketName,
              side: isLong ? 'sell' : 'buy',
              amount,
            },
          },
          'main',
          this.isPaperTrading,
        );

        return { state, action: 'stop', kind: 'rests', ...newRests }
      }

      case 'unsubscribe and switch to idle': {
        depthApi.orderBookDepthSubscription({
          subscription: { marketName, action: 'unsubscribe' },
          strategy: this as Strategy<string>,
          receivedAt,
        });

        this.direction.delete(marketName);

        return { state: 'idle', action: 'stop', kind: 'bare' };
      }

      default:
        throw new Error(`Unknown state "${state}"`);
    }
  }

  private checkOpenDealTresholds(
    expected: IndicatorValue,
    marketName: string,
  ): 'cancel' | 'start deal' | 'between tresholds' {
    const isLong = this.isDirectionLong(marketName);

    if (
      expected === null ||
      isLong && expected < this.params.longReturnToIdleTreshold ||
      !isLong && expected > this.params.shortReturnToIdleTreshold
    ) {
      return 'cancel';
    }

    if (
      isLong && expected >= this.params.longOpenDealTreshold ||
      !isLong && expected <= this.params.shortOpenDealTreshold
    ) {
      return 'start deal';
    }

    return 'between tresholds';
  }

  protected isDirectionLong(marketName: string): boolean {
    const dealDirection = this.direction.get(marketName);

    if (!dealDirection) {
      throw new Error(`Missing strategy direction.`);
    }

    return dealDirection === 'long';
  }

  getTakerFee(marketName: string): number {
    const fees = globalStateService.getFeeByMarketName(marketName);
    if (fees === null) {
      throw new Error(`Missing fees for "${marketName}" market.`);
    }

    return 1 - fees.takerFeeRatio;
  }
}
