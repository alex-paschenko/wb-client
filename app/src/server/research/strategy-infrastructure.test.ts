// app/src/server/research/strategy-infrastructure.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERVER_EVENT } from '../constants/events.js';
import { MARKET_FORECAST_NAME } from '../../shared/constants/storage-entities.js';
import {
  orderReceiptsDao,
  type OrderReceiptRow,
} from '../dao/order-receipts.js';
import { OrderEmulator } from './order-emulator.js';
import { BaseStrategy } from '../strategies/base-strategy.js';
import { eventBus } from '../services/event-bus.js';
import {
  OrderBookDepthService,
  orderBookDepthService,
} from '../services/order-book-depth.js';
import { OrderManager } from '../services/order-manager.js';
import { OrderPersistence } from '../services/order-persistence.js';
import { sequencesPersistence } from '../services/sequences-persistence.js';
import { StrategyManager } from '../services/strategy-manager.js';
import type { Order, OrderError } from '../../shared/types/order-receipt.js';
import type { Strategy, StrategyRunParams } from '../types/strategies.js';
import { decodeDepthHistory } from '../utilities/depth-history-codec.js';
import { encodeDepthHistory } from '../utilities/depth-history-codec.js';
import { isFinalOrderState } from '../utilities/is-final-order-state.js';
import {
  decodeOrderReceipt, encodeOrderReceipt,
} from '../utilities/order-receipt-codec.js';
import { decodeEntireBinary } from
  '../../shared/utilities/codecs/entire-binary-codec.js';

const order: Order = {
  id: 1, client_order_id: 1, market: 'BTC_USDT',
  type: 'Market', side: 'sell', status: 'PARTIALLY_FILLED',
  amount: 10, left: 3, deal_stock: 7, deal_money: 700,
  deal_fee: 0, price: 0, ctime: 1, mtime: 1,
  post_only: false, ioc: false, stp: 'no',
  position_side: 'BOTH', rpi: false, retail: false,
  reduce_only: false,
};

test('research binaries use registered, versioned payloads in entire binary', () => {
  const history = [{
    timestamp: 123.5, event_time: 124.25,
    asks: [[101, 3] as [number, number]],
    bids: [[99, 5] as [number, number]],
  }];
  const depthBytes = encodeDepthHistory(history);
  const receipt = {
    order,
    error: {
      code: 'TEST_ERROR', message: 'Отказ биржи',
      errors: { field: ['amount'], retry: false },
    },
  };
  const orderBytes = encodeOrderReceipt(receipt);
  assert.equal(
    decodeEntireBinary(depthBytes).codecName,
    'order book depth history v1.0',
  );
  assert.equal(
    decodeEntireBinary(orderBytes).codecName,
    'order receipt v1.0',
  );
  assert.deepEqual(decodeDepthHistory(depthBytes), history);
  assert.deepEqual(decodeOrderReceipt(orderBytes), receipt);
  assert.deepEqual(decodeOrderReceipt(encodeOrderReceipt({
    order: null, error: { code: 42, message: 'No order' },
  })), { order: null, error: { code: 42, message: 'No order' } });

  const padded = new Uint8Array(orderBytes.length + 7);
  padded.set(orderBytes, 3);
  assert.deepEqual(decodeOrderReceipt(padded.subarray(3, -4)), receipt);
  assert.throws(() => decodeOrderReceipt(depthBytes), /Unexpected order receipt/);
  assert.throws(() => decodeDepthHistory(orderBytes), /Unexpected depth history/);
  assert.throws(() => decodeOrderReceipt(orderBytes.subarray(0, -1)));
});

test('a partial market order is terminal; a GTC limit is not', () => {
  assert.equal(isFinalOrderState(order), true);
  assert.equal(isFinalOrderState({
    ...order, type: 'Limit', status: 'PARTIALLY_FILLED',
  }), false);
  assert.equal(isFinalOrderState({
    ...order, type: 'Limit', ioc: true,
  }), true);
  assert.equal(isFinalOrderState({
    ...order, status: 'CANCELED_TAKER_BAND',
  }), true);
});

test('depth history preserves old books and rejects the eleventh market', () => {
  const service = new OrderBookDepthService();
  const strategy = { name: 'test', run() {} } as Strategy;
  const saves: Uint8Array[] = [];
  const off = eventBus.on(
    SERVER_EVENT.depthPersistenceRequest,
    ({ data }) => { saves.push(data); },
  );
  service.start();
  try {
    for (let i = 0; i < 10; i++) {
      assert.equal(service.api.orderBookDepthSubscription({
        strategy,
        receivedAt: 1000,
        subscription: { marketName: 'M' + i, action: 'subscribe' },
      }), true);
    }
    assert.equal(service.api.orderBookDepthSubscription({
      strategy,
      receivedAt: 1000,
      subscription: { marketName: 'EXTRA', action: 'subscribe' },
    }), false);
    assert.equal(service.getHistory('EXTRA'), null);
    assert.equal(service.api.orderBookDepthSubscription({
      strategy,
      receivedAt: 1000,
      subscription: { marketName: 'M0', action: 'subscribe' },
    }), true);

    eventBus.emit(SERVER_EVENT.orderBookDepthUpdate, [
      true, {
        timestamp: 1, event_time: 1, update_id: 1,
        bids: [['99', '2']], asks: [['101', '5']],
      }, 'M0',
    ]);
    const first = service.getHistory('M0')![0];
    eventBus.emit(SERVER_EVENT.orderBookDepthUpdate, [
      false, {
        timestamp: 2, event_time: 2, update_id: 2, past_update_id: 1,
        bids: [['99', '3']], asks: [['101', '0'], ['102', '4']],
      }, 'M0',
    ]);
    assert.deepEqual(first.bids, [[99, 2]]);
    assert.deepEqual(first.asks, [[101, 5]]);
    assert.deepEqual(service.getHistory('M0')!.at(-1)?.bids, [[99, 3]]);
    assert.deepEqual(service.getHistory('M0')!.at(-1)?.asks, [[102, 4]]);

    eventBus.emit(SERVER_EVENT.orderBookDepthUpdate, [
      true, {
        timestamp: 3, event_time: 3, update_id: 5,
        bids: [['98', '1']], asks: [['103', '1']],
      }, 'M0',
    ]);
    assert.equal(service.getHistory('M0')?.length, 1);
    assert.deepEqual(decodeDepthHistory(saves[0]).map(
      (snapshot) => snapshot.bids[0][1],
    ), [2, 3]);
  } finally {
    service.stop();
    off();
  }
});

test('failed order receipt preserves the order and its cached identity', async () => {
  const manager = new OrderManager();
  const strategy = { name: 'test', run() {} } as Strategy;
  const oldSequence = sequencesPersistence.getNextOrderId;
  sequencesPersistence.getNextOrderId = async () => 1;
  const snapshots: Array<{ order: Order | null; error: OrderError | null }> = [];
  const off = eventBus.on(SERVER_EVENT.orderPersistenceRequest, (receipt) => {
    snapshots.push({ order: receipt.order, error: receipt.error });
  });
  manager.setReceivedAt('BTC_USDT', 123);
  manager.start();
  try {
    manager.api.createMarketOrder(strategy, {
      marketName: 'BTC_USDT', side: 'sell', amount: '10',
    }, 'main');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(manager.getOrdersForStrategy('BTC_USDT', strategy)[0].order,
      null);

    eventBus.emit(SERVER_EVENT.orderReceived, {
      marketName: 'BTC_USDT', client_order_id: 1,
      paperTrading: true, order, error: null,
    });
    eventBus.emit(SERVER_EVENT.orderReceived, {
      marketName: 'BTC_USDT', client_order_id: 1,
      paperTrading: true, order: null,
      error: { code: 123, message: 'Cancellation rejected' },
    });
    assert.equal(snapshots[1].order, order);
    assert.equal(manager.getOrdersForStrategy('BTC_USDT', strategy)[0].order,
      order);
    assert.throws(() => manager.api.cancelOrder('BTC_USDT', 1));
    manager.api.removeAllOrdersFromCache(strategy, 'BTC_USDT');
    assert.equal(manager.getOrdersForStrategy('BTC_USDT', strategy).length, 0);
  } finally {
    manager.stop();
    off();
    sequencesPersistence.getNextOrderId = oldSequence;
  }
});

test('allocation failure becomes a visible local error', async () => {
  const manager = new OrderManager();
  const strategy = { name: 'test', run() {} } as Strategy;
  const oldSequence = sequencesPersistence.getNextOrderId;
  sequencesPersistence.getNextOrderId = async () => NaN;
  manager.setReceivedAt('BTC_USDT', 124);
  manager.start();
  try {
    manager.api.createMarketOrder(strategy, {
      marketName: 'BTC_USDT', side: 'buy', amount: '1000',
    }, 'main');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const [entry] = manager.getOrdersForStrategy('BTC_USDT', strategy);
    assert.ok(entry.client_order_id < 0);
    assert.equal(entry.order, null);
    assert.equal(entry.error?.code, 'ORDER_ID_UNAVAILABLE');
    manager.api.removeAllOrdersFromCache(strategy, 'BTC_USDT');
  } finally {
    manager.stop();
    sequencesPersistence.getNextOrderId = oldSequence;
  }
});

test('order persistence retries and preserves receipt order within a tick',
  async () => {
    const persistence = new OrderPersistence();
    const original = orderReceiptsDao.insert;
    const rows: OrderReceiptRow[] = [];
    let attempts = 0;
    orderReceiptsDao.insert = async (batch) => {
      attempts++;
      if (attempts === 1) throw new Error('temporary database outage');
      rows.push(...batch);
    };
    persistence.start();
    try {
      for (const id of [1, 2]) {
        eventBus.emit(SERVER_EVENT.orderPersistenceRequest, {
          marketName: 'BTC_USDT', receivedAt: 123,
          client_order_id: id, strategyName: 'test',
          orderKind: 'main', paperTrading: true,
          order: { ...order, client_order_id: id },
          error: null,
        });
      }
      await persistence.stop();
      assert.equal(attempts, 2);
      assert.deepEqual(rows.map(({ receivedAt, receiptSequence }) =>
        [receivedAt, receiptSequence]), [[123, 1], [123, 2]]);
      assert.equal(decodeOrderReceipt(rows[1].data).order
        ?.client_order_id, 2);
    } finally {
      orderReceiptsDao.insert = original;
    }
  });

test('paper market order exhausts available bids and finishes partially', () => {
  // The emulator reads the singleton service used by the application.
  const emulator = new OrderEmulator();
  const strategy = { name: 'test', run() {} } as Strategy;
  const orders: Order[] = [];
  const off = eventBus.on(SERVER_EVENT.orderReceived, ({ order: result }) => {
    if (result) orders.push(result);
  });
  orderBookDepthService.start();
  orderBookDepthService.api.orderBookDepthSubscription({
    strategy,
    receivedAt: 1000,
    subscription: { marketName: 'BTC_USDT', action: 'subscribe' },
  });
  eventBus.emit(SERVER_EVENT.orderBookDepthUpdate, [
    true, {
      timestamp: 1, event_time: 1, update_id: 1,
      asks: [['101', '5']], bids: [['100', '7']],
    }, 'BTC_USDT',
  ]);
  emulator.start();
  try {
    eventBus.emit(SERVER_EVENT.createMarketOrderRequest, {
      paperTrading: true,
      orderRequest: {
        marketName: 'BTC_USDT', client_order_id: 200,
        side: 'sell', amount: '10',
      },
    });
    emulator.stop();
    assert.equal(orders[0].status, 'PARTIALLY_FILLED');
    assert.equal(orders[0].deal_stock, 7);
    assert.equal(orders[0].left, 3);
  } finally {
    emulator.stop();
    orderBookDepthService.stop();
    off();
  }
});

test('strategy cannot continue forever without changing state', () => {
  class InvalidStrategy extends BaseStrategy<'candidate'> {
    protected exec(): { state: 'idle'; action: 'continue' } {
      return { state: 'idle', action: 'continue' };
    }
  }
  const strategy = new InvalidStrategy('invalid');
  const params = {
    storage: [{ marketName: 'BTC_USDT', receivedAt: 1, forecast: {} }],
    orderApi: {} as StrategyRunParams<'candidate'>['orderApi'],
    depthApi: {} as StrategyRunParams<'candidate'>['depthApi'],
    stateChanges: [],
    depthHistory: null,
    orders: [],
  } as unknown as StrategyRunParams<'candidate'>;
  assert.throws(() => strategy.run(params), /continue without a state change/);
});

test('strategy failures complete the waiting tick with an error', () => {
  const manager = new StrategyManager([{
    name: 'throws',
    run() { throw new Error('strategy failed'); },
  }]);
  const results: Array<{ error?: unknown }> = [];
  const off = eventBus.on(
    SERVER_EVENT.strategiesCompleted,
    (result) => { results.push(result); },
  );
  manager.start();
  try {
    eventBus.emit(SERVER_EVENT.runStrategiesRequest, {
      marketName: 'BTC_USDT', size: 1, endedAt: 123,
      accessors: {
        indicators: {
          [MARKET_FORECAST_NAME]: { get: () => null },
        },
      } as never,
    });
    assert.match((results[0].error as Error).message, /strategy failed/);
  } finally {
    manager.stop();
    off();
  }
});

test('depth updates run only the strategies subscribed to the market', () => {
  let firstRuns = 0;
  let secondRuns = 0;
  const first = {
    name: 'first', run() { firstRuns++; },
  } as Strategy;
  const second = {
    name: 'second', run() { secondRuns++; },
  } as Strategy;
  const manager = new StrategyManager([first, second]);
  orderBookDepthService.start();
  manager.start();
  try {
    eventBus.emit(SERVER_EVENT.runStrategiesRequest, {
      marketName: 'BTC_USDT', size: 1, endedAt: 123,
      accessors: {
        indicators: {
          [MARKET_FORECAST_NAME]: { get: () => null },
        },
      } as never,
    });
    assert.deepEqual([firstRuns, secondRuns], [1, 1]);
    orderBookDepthService.api.orderBookDepthSubscription({
      strategy: first, receivedAt: 123,
      subscription: { marketName: 'BTC_USDT', action: 'subscribe' },
    });
    eventBus.emit(SERVER_EVENT.orderBookDepthUpdate, [
      true, {
        timestamp: 1, event_time: 1, update_id: 1,
        asks: [['101', '1']], bids: [['100', '1']],
      }, 'BTC_USDT',
    ]);
    assert.deepEqual([firstRuns, secondRuns], [2, 1]);
  } finally {
    manager.stop();
    orderBookDepthService.stop();
  }
});
