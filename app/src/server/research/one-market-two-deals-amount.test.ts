import assert from 'node:assert/strict';
import { test } from 'node:test';

import { globalStateService } from '../../shared/services/global-state.js';
import type { Market } from '../../shared/types/market.js';
import type { Order } from '../../shared/types/order-receipt.js';
import { OneMarketTwoDeals } from '../strategies/one-market-two-deals.js';
import type { OrderApi, OrderMarketPreRequest } from '../types/orders.js';
import type { OneMarketTwoDealsStrategyState, Strategy, StrategyRunParams } from '../types/strategies.js';

const marketTemplate: Market = {
  name: 'BTC_USDT', stock: 'BTC', money: 'USDT',
  stockPrec: 8, moneyPrec: 8, feePrec: 4,
  makerFee: 0.001, takerFee: 0.001,
  minAmount: 0.0001, minTotal: 0.00001, maxTotal: 0,
  tradesEnabled: true, isActive: true,
  isCollateral: false, isTradFiFutures: false,
  type: 'spot', tickSize: null, stepSize: null, delistedAt: null,
};

const params = {
  longCandidateTreshold: 2.25,
  shortCandidateTreshold: -2.25,
  longReturnToIdleTreshold: 2,
  shortReturnToIdleTreshold: -2,
  longOpenDealTreshold: 2.5,
  shortOpenDealTreshold: -2.5,
  longCloseDealTreshold: -1.5,
  shortCloseDealTreshold: 1.5,
};

for (const { stock, money, price } of [
  { stock: 'BTC', money: 'USDT', price: 100_000 },
  { stock: 'USDT', money: 'BTC', price: 0.00001 },
]) {
  for (const isLong of [true, false]) {
    test(`${stock}_${money} ${isLong ? 'long' : 'short'} opens a 1000 USDT position and closes in the reverse currency`, () => {
      const marketName = `${stock}_${money}`;
      const market: Market = { ...marketTemplate, name: marketName, stock, money };
      globalStateService.setMarketData({ [marketName]: market }, {
        [marketName]: {
          makerFeeRatio: 0.001,
          takerFeeRatio: 0.001,
          rpiMakerFeePremiumRatio: null,
        },
      });

      const requests: OrderMarketPreRequest[] = [];
      const orderApi: OrderApi = {
        createOrder(_strategy, request) {
          requests.push(request.orderRequest);
        },
        cancelOrder() {},
        removeAllOrdersFromCache() {},
      };
      const strategy = new OneMarketTwoDeals(params);
      const forecast = (value: number) => ({
        expectedResidual1m3Ema: value,
        expectedResidual1m4Ema: value,
        expectedResidual1mCombined: value,
      });
      const storage = [{
        marketName, receivedAt: 1000, price,
        forecast: forecast(isLong ? 4 : -4),
      }];
      const runParams: StrategyRunParams<OneMarketTwoDealsStrategyState> = {
        storage,
        orderApi,
        depthApi: { orderBookDepthSubscription: () => true },
        depthHistory: null,
        orders: [],
        stateChanges: [],
      } as StrategyRunParams<OneMarketTwoDealsStrategyState>;

      strategy.run(runParams);
      assert.equal(runParams.stateChanges.at(-1)?.state, 'awaiting for order book depth data');
      runParams.depthHistory = [{
        timestamp: 1, event_time: 1, asks: [], bids: [],
      }];
      strategy.run(runParams);

      const first = requests[0];
      assert.ok(first);
      assert.equal(first.side, isLong ? 'buy' : 'sell');
      const expectedAmount = isLong
        ? money === 'USDT' ? 1000 : 1000 * price
        : stock === 'USDT' ? 1000 : 1000 / price;
      assert.ok(Math.abs(first.amount - expectedAmount) < 1e-7,
        `expected ${expectedAmount}, got ${first.amount}`);

      // A buy spends quote money, while a sell spends stock.
      const executedStock = isLong ? first.amount / price : first.amount;
      const executedMoney = executedStock * price;
      const executed: Order = {
        id: 1, client_order_id: 1, market: marketName,
        type: 'Market', side: first.side, status: 'FILLED',
        amount: first.amount, left: 0,
        deal_stock: executedStock, deal_money: executedMoney,
        deal_fee: executedMoney * 0.001, price: 0, ctime: 1, mtime: 1,
        post_only: false, ioc: false, stp: 'no',
        position_side: 'BOTH', rpi: false, retail: false, reduce_only: false,
      };
      runParams.orders = [{
        client_order_id: 1, order: executed,
        error: null, isOrderUpdated: true, isFinalized: true,
        isPaperTrading: true, strategy: strategy as Strategy<string>, orderKind: 'main',
      }];
      strategy.run(runParams);
      assert.equal(runParams.stateChanges.at(-1)?.state, 'holding');

      runParams.orders = [];
      storage[0].forecast = forecast(isLong ? -4 : 4);
      strategy.run(runParams);
      const second = requests[1];
      assert.ok(second);
      assert.equal(second.side, isLong ? 'sell' : 'buy');
      assert.ok(Math.abs(second.amount - (isLong
        ? executedStock * 0.999 : executedMoney * 0.999)) < 1e-7,
        `unexpected close amount: ${second.amount}`);
    });
  }
}

for (const isLong of [true, false]) {
  for (const dust of [true, false]) {
    test(`second ${isLong ? 'sell' : 'buy'} updates rests with ${dust ? 'dust' : 'retryable'} remainder`, () => {
    const marketName = 'BTC_USDT';
    globalStateService.setMarketData({ [marketName]: {
      ...marketTemplate, minAmount: 0.001, minTotal: 1,
    } }, {
      [marketName]: {
        makerFeeRatio: 0.001, takerFeeRatio: 0.001,
        rpiMakerFeePremiumRatio: null,
      },
    });

    const requests: OrderMarketPreRequest[] = [];
    const orderApi: OrderApi = {
      createOrder(_strategy, request) { requests.push(request.orderRequest); },
      cancelOrder() {},
      removeAllOrdersFromCache() {},
    };
    const strategy = new OneMarketTwoDeals(params);
    const forecast = (value: number) => ({
      expectedResidual1m3Ema: value,
      expectedResidual1m4Ema: value,
      expectedResidual1mCombined: value,
    });
    const storage = [{
      marketName, receivedAt: 1000, price: 100,
      forecast: forecast(isLong ? 4 : -4),
    }];
    const runParams: StrategyRunParams<OneMarketTwoDealsStrategyState> = {
      storage, orderApi,
      depthApi: { orderBookDepthSubscription: () => true },
      depthHistory: null, orders: [], stateChanges: [],
    };
    const makeOrder = (id: number, side: 'buy' | 'sell',
      amount: number, dealStock: number, dealMoney: number): Order => ({
      id, client_order_id: id, market: marketName, type: 'Market', side,
      status: 'PARTIALLY_FILLED', amount,
      left: side === 'buy' ? amount - dealMoney : amount - dealStock,
      deal_stock: dealStock, deal_money: dealMoney,
      deal_fee: dealMoney * 0.001, price: 0, ctime: 1, mtime: id,
      post_only: false, ioc: false, stp: 'no',
      position_side: 'BOTH', rpi: false, retail: false, reduce_only: false,
    });
    const setExecuted = (order: Order) => {
      runParams.orders = [{
        client_order_id: order.client_order_id, order,
        error: null, isOrderUpdated: true, isFinalized: true,
        isPaperTrading: true, strategy: strategy as Strategy<string>,
        orderKind: 'main',
      }];
    };

    strategy.run(runParams);
    runParams.depthHistory = [{
      timestamp: 1, event_time: 1, asks: [], bids: [],
    }];
    strategy.run(runParams);
    assert.equal(requests.length, 1);
    const first = requests[0];
    setExecuted(makeOrder(1, first.side, first.amount,
      10, 1000));
    strategy.run(runParams);
    assert.equal(runParams.stateChanges.at(-1)?.state, 'holding');

    runParams.orders = [];
    storage[0].forecast = forecast(isLong ? -4 : 4);
    strategy.run(runParams);
    assert.equal(requests.length, 2);

    const second = requests[1];
    const restsBefore = (strategy as unknown as {
      rests: Map<string, { stock: number; money: number }>;
    }).rests.get(marketName)!;
    const dealMoney = isLong
      ? (second.amount - (dust ? 0.0001 : 0.01)) * 100
      : second.amount - (dust ? 0.001 : 20);
    const dealStock = dealMoney / 100;
    setExecuted(makeOrder(2, second.side, second.amount, dealStock, dealMoney));
    strategy.run(runParams);

    assert.equal(runParams.stateChanges.at(-1)?.state, dust
      ? 'idle' : 'awaiting for second main order creation');
    assert.equal(requests.length, dust ? 2 : 3,
      'retry should be created only for a tradable remainder');
    const finalRests = (strategy as unknown as {
      rests: Map<string, { stock: number; money: number }>;
    }).rests.get(marketName)!;
    const expectedMoney = isLong
      ? restsBefore.money + dealMoney * 0.999
      : restsBefore.money - dealMoney;
    const expectedStock = isLong
      ? restsBefore.stock - dealStock
      : restsBefore.stock + dealStock * 0.999;
    assert.ok(Math.abs(finalRests.money - expectedMoney) < 1e-8);
    assert.ok(Math.abs(finalRests.stock - expectedStock) < 1e-8);
    const recorded = runParams.stateChanges.slice().reverse().find(
      (change) => change.state === (dust
        ? 'unsubscribe and switch to idle'
        : 'awaiting for second main order creation'),
    );
    assert.ok(recorded);
    assert.ok(Math.abs(recorded.money! - expectedMoney) < 1e-8);
    assert.ok(Math.abs(recorded.stock! - expectedStock) < 1e-8);
    if (!dust) {
      const expectedAmount = isLong ? expectedStock : expectedMoney;
      assert.ok(Math.abs(requests[2].amount - expectedAmount) < 1e-7);
    }
  });
  }
}
