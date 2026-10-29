// app/src/server/strategies/one-market-two-deals.ts

import type { OrderAndStrategy, OrderApi } from '../types/orders.js';
import type {
  OneMarketTwoDealsStrategyState,
  Strategy,
  StrategyDirection,
  StrategyStates,
  StrategyRests,
  StrategyRunParams,
} from '../types/strategies.js';
import { REVERT_ORDER_ERROR } from '../constants/order-error-codes.js';
import { BaseStrategy } from './base-strategy.js';
import { OrderErrorCode } from '../../shared/types/order-receipt.js';
import { IndicatorValue } from '../../shared/types/data-types.js';
import { globalStateService } from '../../shared/services/global-state.js';

const FATAL_ERRORS: Set<OrderErrorCode> = new Set([
  REVERT_ORDER_ERROR['trading in the market is not allowed'],
]);

let numOfCycles = 0;

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
        if (this.isMarketRestricted(marketName, 'spot', ['USDT'])) {
          return { state, action: 'stop' };
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
            return { state: 'candidate', action: 'continue' };
          }
        }

        return { state, action: 'stop' };
      }

      case 'candidate': {
        const result = this.checkOpenDealTresholds(expectedCombined, marketName);

        if (result === 'cancel') {
          return {
            state: 'unsubscribe and switch to idle',
            action: 'continue',
          };
        }

        return {
          state: 'awaiting for order book depth data',
          action: 'stop',
        };
      }

      case 'awaiting for order book depth data':
        const result = this.checkOpenDealTresholds(expectedCombined, marketName);

        if (result === 'cancel') {
          return {
            state: 'unsubscribe and switch to idle',
            action: 'continue',
          };
        }

        if (result === 'start deal' && depthHistory && depthHistory.length > 0) {
          const isLong = this.isDirectionLong(marketName);

          if (orders.length > 0) {
            throw new Error(`Uncompleted old orders found.`);
          }

          // TODO: replace the fixed USDT budget after switch to real trading.
          const market = globalStateService.getMarket(marketName);
          if (!market) {
            throw new Error(`Market not found: "${marketName}"`);
          }
          
          const usdtAmount = 1000;
          const rawAmount = isLong
            ? market.money === 'USDT' ? usdtAmount : usdtAmount * lastStorage.price
            : market.stock === 'USDT' ? usdtAmount : usdtAmount / lastStorage.price;

          const amount = this.normalizedAmount(
            rawAmount,
            marketName,
            isLong ? 'money' : 'stock',
          );

          if (amount === 0) {
            return { state: 'unsubscribe and switch to idle', action: 'stop' };
          }

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
            ...newRests,
          };
        }

        return { state, action: 'stop' };

      case 'awaiting for first main order creation': {
        const isLong = this.isDirectionLong(marketName);

        const mainEntry = orders.find((o) => o.orderKind === 'main');
        if (!this.isOrderCommandCompleted(mainEntry)) {
          return {
            state,
            action: 'stop',
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
                errorCode,
              }
            : {
                state: 'candidate',
                action: 'stop',
                errorCode,
              };

        }

        if (!mainEntry.isOrderUpdated || !mainEntry.isFinalized) {
          return {
            state,
            action: 'stop',
            ...this.getRests(marketName),
          };
        }

        orderApi.removeAllOrdersFromCache(this, marketName);

        if (!mainEntry.order) {
          console.error(`Did not received neither order nor error`);

          return {
            state: 'unsubscribe and switch to idle',
            action: 'stop',
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
            ...newRests,
          };
        }

        return {
          state: 'holding',
          action: 'continue',
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
          const rawAmount = isLong ? rests.stock : rests.money;
          const amount = this.normalizedAmount(
            rawAmount,
            marketName,
            isLong ? 'stock' : 'money',
          );

          if (amount <= 0) {
            return {
              state: 'unsubscribe and switch to idle',
              action: 'continue',
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
            ...rests,
          };
        }

        return { state, action: 'stop', ...rests };
      }

      case 'awaiting for second main order creation': {
        const isLong = this.isDirectionLong(marketName);

        const mainEntry = orders.find((o) => o.orderKind === 'main');
        if (!this.isOrderCommandCompleted(mainEntry)) {
          return {
            state,
            action: 'stop',
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
                errorCode,
              }
            : {
                state: 'holding',
                action: 'stop',
                errorCode,
              };

        }

        if (!mainEntry.isOrderUpdated || !mainEntry.isFinalized) {
          return {
            state,
            action: 'stop',
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
            errorCode:
              REVERT_ORDER_ERROR['did not received neither order nor error'],
          };
        }

        const fee = this.getTakerFee(marketName);

        const rests = this.getRests(marketName);

        const newRests: StrategyRests = isLong
          ? {
              money: rests.money + order.deal_money * fee,
              stock: rests.stock - order.deal_stock,
            }
          : {
              money: rests.money - order.deal_money,
              stock: rests.stock + order.deal_stock * fee,
            };

        this.rests.set(marketName, newRests);

        const rawAmount = isLong ? newRests.stock : newRests.money;
        const amount = this.normalizedAmount(
          rawAmount,
          marketName,
          isLong ? 'stock' : 'money',
        );

        if (amount <= 0) {
          // TODO: For testing purpose only!
          console.log(
            `DEAL #${++numOfCycles}: ${marketName} [${isLong ? 'long' : 'short'}] `,
            newRests,
          );

          return {
            state: 'unsubscribe and switch to idle',
            action: 'continue',
            ...newRests,
          };
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

        return { state, action: 'stop', ...newRests }
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
