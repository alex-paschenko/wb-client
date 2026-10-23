// app/src/server/research/order-manager-lifecycle.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERVER_EVENT } from '../constants/events.js';
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

test('manager subscribes once per active market and discards stale updates',
  async () => {
    const manager = new OrderManager();
    const strategy = { name: 'isolated', run() {} } as Strategy;
    const before = sequencesPersistence.getNextOrderId;
    let next = 0;
    sequencesPersistence.getNextOrderId = async () => ++next;
    const commands: Array<{ subscription: string[] | null }> = [];
    const off = eventBus.on(
      SERVER_EVENT.createOrderRequestAndSubscribe,
      e => { commands.push({ subscription: e.subscription }); },
    );
    manager.setReceivedAt('BTC_USD', 123);
    manager.start();
    try {
      const create = () => manager.api.createOrder(strategy, {
        orderType: 'Limit',
        orderRequest: {
          marketName: 'BTC_USD', side: 'buy', amount: 2, price: 100,
        },
      }, 'main');
      create();
      await manager.waitForPendingRequests();
      create();
      await manager.waitForPendingRequests();
      assert.deepEqual(commands.map(c => c.subscription), [
        ['BTC_USD'], null,
      ]);
      const deliver = (id: number, status: Order['status'], mtime: number,
        eventId: 1 | 2 | 3) => {
        eventBus.emit(SERVER_EVENT.orderUpdated, {
          paperTrading: true, eventId,
          order: { ...example, client_order_id: id, status, mtime },
        });
      };
      deliver(1, 'OPEN', 10, 1);
      deliver(2, 'OPEN', 10, 1);
      deliver(1, 'PARTIALLY_FILLED', 11, 2);
      deliver(1, 'CANCELED', 12, 3);
      assert.equal(commands.length, 2);
      eventBus.emit(SERVER_EVENT.orderReceived, {
        marketName: 'BTC_USD', client_order_id: 1, paperTrading: true,
        order: { ...example, mtime: 2 }, error: null,
      });
      assert.equal(manager.getOrdersForStrategy('BTC_USD', strategy)
        .find(o => o.client_order_id === 1)?.order?.status, 'CANCELED');
      deliver(2, 'FILLED', 12, 3);
      assert.deepEqual(commands.at(-1)?.subscription, []);
      assert.equal(manager.getOrdersForStrategy('BTC_USD', strategy)
        .every(o => o.isFinalized), true);
      manager.api.removeAllOrdersFromCache(strategy, 'BTC_USD');
    } finally {
      manager.stop();
      off();
      sequencesPersistence.getNextOrderId = before;
    }
  });

test('manager preserves error source and only internal unknown is pending',
  async () => {
    const { REVERT_ORDER_ERROR, REVERT_WB_ORDER_ERROR } = await import(
      '../constants/order-error-codes.js'
    );
    const manager = new OrderManager(false);
    const strategy = { name: 'errors', run() {} } as Strategy;
    const before = sequencesPersistence.getNextOrderId;
    sequencesPersistence.getNextOrderId = async () => 123;
    manager.setReceivedAt('BTC_USD', 42);
    manager.start();
    try {
      manager.api.createOrder(strategy, {
        orderType: 'Market',
        orderRequest: {
          marketName: 'BTC_USD', side: 'buy', amount: 1000,
        },
      }, 'main');
      await manager.waitForPendingRequests();
      const entry = manager.getOrdersForStrategy('BTC_USD', strategy)[0];
      eventBus.emit(SERVER_EVENT.orderReceived, {
        marketName: 'BTC_USD', client_order_id: 123,
        paperTrading: false, order: null,
        error: {
          code: REVERT_ORDER_ERROR['order outcome unknown'],
          isWBError: false,
        },
      });
      assert.deepEqual(entry.error, {
        code: REVERT_ORDER_ERROR['order outcome unknown'],
        isWBError: false,
      });
      assert.equal(entry.isFinalized, false);
      eventBus.emit(SERVER_EVENT.orderReceived, {
        marketName: 'BTC_USD', client_order_id: 123,
        paperTrading: false, order: null,
        error: {
          code: REVERT_WB_ORDER_ERROR['balance not enough'],
          isWBError: true,
        },
      });
      assert.deepEqual(entry.error, {
        code: REVERT_WB_ORDER_ERROR['balance not enough'],
        isWBError: true,
      });
      assert.equal(entry.isFinalized, true);
      manager.api.removeAllOrdersFromCache(strategy, 'BTC_USD');
    } finally {
      manager.stop();
      sequencesPersistence.getNextOrderId = before;
    }
  });
