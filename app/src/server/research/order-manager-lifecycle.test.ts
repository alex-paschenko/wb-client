// app/src/server/research/order-manager-lifecycle.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERVER_EVENT } from '../constants/events.js';
import { REVERT_ORDER_ERROR, REVERT_WB_ORDER_ERROR } from
  '../constants/order-error-codes.js';
import { eventBus } from '../services/event-bus.js';
import { OrderManager } from '../services/order-manager.js';
import { sequencesPersistence } from '../services/sequences-persistence.js';
import type { Strategy } from '../types/strategies.js';
import type { Order } from '../../shared/types/order-receipt.js';

const example: Order = {
  id: 1, client_order_id: 1, market: 'BTC_USD',
  type: 'Limit', side: 'buy', status: 'OPEN',
  amount: 2, left: 2, deal_stock: 0, deal_money: 0,
  deal_fee: 0, price: 100, ctime: 1, mtime: 1,
  post_only: false, ioc: false, stp: 'no',
  position_side: 'BOTH', rpi: false, retail: false,
  reduce_only: false,
};

const strategy = { name: 'isolated', run() {} } as Strategy;

function result(id: number, error: { code: number; isWBError: boolean } | null,
  isPaperTrading = true): void {
  eventBus.emit(SERVER_EVENT.orderRequestResult, {
    marketName: 'BTC_USD', client_order_id: id, isPaperTrading, error,
  });
}

function update(id: number, status: Order['status'], mtime: number,
  eventId: 1 | 2 | 3, isPaperTrading = true): void {
  eventBus.emit(SERVER_EVENT.orderUpdated, {
    isPaperTrading, eventId,
    order: { ...example, client_order_id: id, status, mtime },
  });
}

test('command reply never modifies an order, including after final update',
  async () => {
    const manager = new OrderManager();
    const oldSequence = sequencesPersistence.getNextOrderId;
    sequencesPersistence.getNextOrderId = async () => 101;
    manager.setReceivedAt('BTC_USD', 123);
    manager.start();
    try {
      manager.api.createOrder(strategy, {
        orderType: 'Limit', orderRequest: {
          marketName: 'BTC_USD', side: 'buy', amount: 2, price: 100,
        },
      }, 'main', true);
      await manager.waitForPendingRequests();
      const entry = manager.getOrdersForStrategy('BTC_USD', strategy)[0];
      assert.equal(entry.error, undefined);
      assert.equal(entry.isOrderUpdated, false);
      update(101, 'OPEN', 10, 1);
      assert.equal(entry.isOrderUpdated, true);
      assert.equal(entry.error, undefined);
      update(101, 'CANCELED', 10, 3);
      assert.equal(entry.isFinalized, true);
      assert.equal(entry.order?.status, 'CANCELED');
      result(101, null);
      assert.equal(entry.error, null);
      assert.equal(entry.order?.status, 'CANCELED');
      manager.api.removeAllOrdersFromCache(strategy, 'BTC_USD');
    } finally {
      manager.stop();
      sequencesPersistence.getNextOrderId = oldSequence;
    }
  });

test('cancellation resets only command and update flags, not order',
  async () => {
    const manager = new OrderManager();
    const oldSequence = sequencesPersistence.getNextOrderId;
    sequencesPersistence.getNextOrderId = async () => 102;
    manager.setReceivedAt('BTC_USD', 123);
    manager.start();
    try {
      manager.api.createOrder(strategy, {
        orderType: 'Limit', orderRequest: {
          marketName: 'BTC_USD', side: 'buy', amount: 2, price: 100,
        },
      }, 'main', true);
      await manager.waitForPendingRequests();
      result(102, null);
      update(102, 'OPEN', 10, 1);
      const entry = manager.getOrdersForStrategy('BTC_USD', strategy)[0];
      manager.api.cancelOrder('BTC_USD', 102);
      assert.equal(entry.error, undefined);
      assert.equal(entry.isOrderUpdated, false);
      assert.equal(entry.order?.status, 'OPEN');
      assert.equal(entry.isFinalized, false);
      assert.throws(() => manager.api.cancelOrder('BTC_USD', 102));
      result(102, {
        code: REVERT_WB_ORDER_ERROR['order not found'], isWBError: true,
      });
      assert.equal(entry.isFinalized, false);
      assert.equal(entry.order?.status, 'OPEN');
      update(102, 'CANCELED', 11, 3);
      assert.equal(entry.isFinalized, true);
      assert.equal(entry.isOrderUpdated, true);
      assert.ok(entry.error);
      manager.api.removeAllOrdersFromCache(strategy, 'BTC_USD');
    } finally {
      manager.stop();
      sequencesPersistence.getNextOrderId = oldSequence;
    }
  });

test('rejected create can be removed without fictional final order',
  async () => {
    const manager = new OrderManager();
    const oldSequence = sequencesPersistence.getNextOrderId;
    sequencesPersistence.getNextOrderId = async () => 103;
    manager.setReceivedAt('BTC_USD', 123);
    manager.start();
    try {
      manager.api.createOrder(strategy, {
        orderType: 'Market', orderRequest: {
          marketName: 'BTC_USD', side: 'buy', amount: 200,
        },
      }, 'main', true);
      await manager.waitForPendingRequests();
      result(103, { code: REVERT_WB_ORDER_ERROR['balance not enough'],
        isWBError: true });
      const entry = manager.getOrdersForStrategy('BTC_USD', strategy)[0];
      assert.equal(entry.isFinalized, false);
      assert.equal(entry.order, null);
      assert.equal(entry.isOrderUpdated, false);
      manager.api.removeAllOrdersFromCache(strategy, 'BTC_USD');
    } finally {
      manager.stop();
      sequencesPersistence.getNextOrderId = oldSequence;
    }
  });

test('unknown result keeps undefined until real response or reconciliation',
  async () => {
    const manager = new OrderManager();
    const oldSequence = sequencesPersistence.getNextOrderId;
    sequencesPersistence.getNextOrderId = async () => 104;
    manager.setReceivedAt('BTC_USD', 123);
    manager.start();
    try {
      manager.api.createOrder(strategy, {
        orderType: 'Market', orderRequest: {
          marketName: 'BTC_USD', side: 'buy', amount: 200,
        },
      }, 'main', false);
      await manager.waitForPendingRequests();
      result(104, { code: REVERT_ORDER_ERROR['order outcome unknown'],
        isWBError: false }, false);
      const entry = manager.getOrdersForStrategy('BTC_USD', strategy)[0];
      assert.equal(entry.error, undefined);
      assert.throws(() => manager.api.removeAllOrdersFromCache(strategy,
        'BTC_USD'));
      result(104, null, false);
      update(104, 'FILLED', 10, 3, false);
      assert.equal(entry.isFinalized, true);
      manager.api.removeAllOrdersFromCache(strategy, 'BTC_USD');
    } finally {
      manager.stop();
      sequencesPersistence.getNextOrderId = oldSequence;
    }
  });

test('paper and real orders share a market but real subscription is separate',
  async () => {
    const manager = new OrderManager();
    const oldSequence = sequencesPersistence.getNextOrderId;
    let next = 200;
    sequencesPersistence.getNextOrderId = async () => ++next;
    const commands: Array<{ isPaperTrading: boolean;
      subscription: string[] | null }> = [];
    const off = eventBus.on(SERVER_EVENT.createOrderRequestAndSubscribe,
      event => { commands.push(event); });
    manager.setReceivedAt('BTC_USD', 123);
    manager.start();
    try {
      const create = (isPaperTrading: boolean) => manager.api.createOrder(
        strategy, { orderType: 'Limit', orderRequest: {
          marketName: 'BTC_USD', side: 'buy', amount: 2, price: 100,
        } }, 'main', isPaperTrading,
      );
      create(true);
      await manager.waitForPendingRequests();
      create(false);
      await manager.waitForPendingRequests();
      assert.deepEqual(commands.slice(0, 2).map(c =>
        [c.isPaperTrading, c.subscription]), [
        [true, null], [false, ['BTC_USD']],
      ]);
      result(201, null, true);
      update(201, 'FILLED', 10, 3, true);
      assert.equal(manager.getOrdersForStrategy('BTC_USD', strategy)
        .find(e => e.client_order_id === 201)?.isPaperTrading, true);
      assert.equal(commands.length, 2);
      result(202, null, false);
      update(202, 'FILLED', 10, 3, false);
      assert.deepEqual(commands.at(-1)?.subscription, []);
      assert.equal(commands.at(-1)?.isPaperTrading, false);
      manager.api.removeAllOrdersFromCache(strategy, 'BTC_USD');
    } finally {
      off();
      manager.stop();
      sequencesPersistence.getNextOrderId = oldSequence;
    }
  });

test('first order receipt retains decision tick across asynchronous ID allocation',
  async () => {
    const manager = new OrderManager();
    const oldSequence = sequencesPersistence.getNextOrderId;
    let release!: (id: number) => void;
    sequencesPersistence.getNextOrderId = () => new Promise<number>((resolve) => {
      release = resolve;
    });
    const receivedAts: number[] = [];
    const off = eventBus.on(SERVER_EVENT.orderPersistenceRequest,
      (event) => { receivedAts.push(event.receivedAt); });
    manager.setReceivedAt('BTC_USD', 100);
    manager.start();
    try {
      manager.api.createOrder(strategy, {
        orderType: 'Market', orderRequest: {
          marketName: 'BTC_USD', side: 'buy', amount: 1,
        },
      }, 'main', true);
      manager.setReceivedAt('BTC_USD', 101);
      release(200);
      await manager.waitForPendingRequests();
      assert.equal(receivedAts[0], 100);
      result(200, null);
      assert.equal(receivedAts.at(-1), 101);
    } finally {
      off();
      manager.stop();
      sequencesPersistence.getNextOrderId = oldSequence;
    }
  });
