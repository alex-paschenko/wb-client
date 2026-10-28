// app/src/server/research/order-emulator-updates.test.ts

import assert from 'node:assert/strict';
import { globalStateService } from '../../shared/services/global-state.js';
import { test } from 'node:test';
import { SERVER_EVENT } from '../constants/events.js';
import { REVERT_WB_ORDER_ERROR } from '../constants/order-error-codes.js';
import { OrderEmulator } from './order-emulator.js';
import { eventBus } from '../services/event-bus.js';
import { orderBookDepthService } from '../services/order-book-depth.js';
import type { OrderUpdatedEvent } from '../types/events.js';
import type { Strategy } from '../types/strategies.js';

globalStateService.setMarketData(
  { BTC_USD: {} as never, ETH_USD: {} as never },
  {
    BTC_USD: { makerFeeRatio: 0.001, takerFeeRatio: 0.001,
      rpiMakerFeePremiumRatio: null },
    ETH_USD: { makerFeeRatio: 0.001, takerFeeRatio: 0.001,
      rpiMakerFeePremiumRatio: null },
  },
);


test('emulator publishes event 3 for canceled resting limit order', () => {
  const emulator = new OrderEmulator();
  const strategy = { name: 'emulator-test', run() {} } as Strategy;
  const updates: OrderUpdatedEvent[] = [];
  const off = eventBus.on(SERVER_EVENT.orderUpdated, update => {
    updates.push(update);
  });
  orderBookDepthService.start();
  orderBookDepthService.api.orderBookDepthSubscription({
    strategy, receivedAt: 1000,
    subscription: { marketName: 'BTC_USD', action: 'subscribe' },
  });
  eventBus.emit(SERVER_EVENT.orderBookDepthUpdate, [
    true, {
      timestamp: 1, event_time: 1, update_id: 1,
      asks: [['101', '5']], bids: [['100', '5']],
    }, 'BTC_USD',
  ]);
  emulator.start();
  try {
    eventBus.emit(SERVER_EVENT.createOrderRequestAndSubscribe, {
      isPaperTrading: true,
      orderType: 'Limit',
      subscription: ['BTC_USD'],
      orderRequest: {
        marketName: 'BTC_USD', side: 'buy', amount: 2,
        price: 99, client_order_id: 20,
      },
    });
    // stop flushes the deferred creation, like the existing emulator tests.
    emulator.stop();
    emulator.start();
    eventBus.emit(SERVER_EVENT.orderCancelRequest, {
      market: 'BTC_USD', client_order_id: 20, isPaperTrading: true,
    });
    emulator.stop();
    assert.equal(updates.length, 2);
    assert.equal(updates[0].eventId, 1);
    assert.equal(updates[1].eventId, 3);
    assert.equal(updates[1].order.status, 'CANCELED');
    assert.equal(updates[1].order.client_order_id, 20);
  } finally {
    emulator.stop();
    orderBookDepthService.stop();
    off();
  }
});

test('paper order creation and cancellation update manager finalization',
  async () => {
    const { OrderManager } = await import('../services/order-manager.js');
    const { sequencesPersistence } = await import(
      '../services/sequences-persistence.js'
    );
    const oldSequence = sequencesPersistence.getNextOrderId;
    sequencesPersistence.getNextOrderId = async () => 55;
    const strategy = { name: 'paper-integration', run() {} } as Strategy;
    const manager = new OrderManager();
    const emulator = new OrderEmulator();
    manager.setReceivedAt('BTC_USD', 321);
    manager.start();
    orderBookDepthService.start();
    orderBookDepthService.api.orderBookDepthSubscription({
      strategy, receivedAt: 321,
      subscription: { marketName: 'BTC_USD', action: 'subscribe' },
    });
    eventBus.emit(SERVER_EVENT.orderBookDepthUpdate, [
      true, {
        timestamp: 1, event_time: 1, update_id: 1,
        asks: [['101', '5']], bids: [['100', '5']],
      }, 'BTC_USD',
    ]);
    emulator.start();
    try {
      manager.api.createOrder(
        strategy,
        {
          orderType: 'Limit',
          orderRequest: {
            marketName: 'BTC_USD', side: 'buy', amount: 2, price: 99,
          },
        },
        'main',
        true,
      );
      await manager.waitForPendingRequests();
      emulator.stop();
      const getEntry = () => manager.getOrdersForStrategy('BTC_USD', strategy)[0];
      assert.equal(getEntry().order?.status, 'OPEN');
      assert.equal(getEntry().isFinalized, false);
      emulator.start();
      manager.api.cancelOrder('BTC_USD', 55);
      emulator.stop();
      assert.equal(getEntry().order?.status, 'CANCELED');
      assert.equal(getEntry().isFinalized, true);
      manager.api.removeAllOrdersFromCache(strategy, 'BTC_USD');
    } finally {
      emulator.stop();
      manager.stop();
      orderBookDepthService.stop();
      sequencesPersistence.getNextOrderId = oldSequence;
    }
  });

test('emulator returns WB-classified liquidity error by numeric alias', () => {
  const strategy = { name: 'liquidity-test', run() {} } as Strategy;
  const emulator = new OrderEmulator();
  const errors: Array<{ code: number; isWBError: boolean }> = [];
  const off = eventBus.on(SERVER_EVENT.orderRequestResult, (event) => {
    if (event.error) errors.push(event.error);
  });
  orderBookDepthService.start();
  orderBookDepthService.api.orderBookDepthSubscription({
    strategy, receivedAt: 100,
    subscription: { marketName: 'ETH_USD', action: 'subscribe' },
  });
  eventBus.emit(SERVER_EVENT.orderBookDepthUpdate, [
    true, {
      timestamp: 1, event_time: 1, update_id: 1,
      bids: [], asks: [['100', '5']],
    }, 'ETH_USD',
  ]);
  emulator.start();
  try {
    eventBus.emit(SERVER_EVENT.createOrderRequestAndSubscribe, {
      isPaperTrading: true, orderType: 'Market',
      subscription: ['ETH_USD'],
      orderRequest: {
        marketName: 'ETH_USD', side: 'sell', amount: 1,
        client_order_id: 456,
      },
    });
    emulator.stop();
    assert.deepEqual(errors, [{
      code: REVERT_WB_ORDER_ERROR['not enough traders'],
      isWBError: true,
    }]);
  } finally {
    emulator.stop();
    orderBookDepthService.stop();
    off();
  }
});

test('paper validation uses documented WS errors, not paper-only codes', () => {
  const emulator = new OrderEmulator();
  const errors: Array<{ code: number; isWBError: boolean }> = [];
  const off = eventBus.on(SERVER_EVENT.orderRequestResult, event => {
    if (event.error) errors.push(event.error);
  });
  emulator.start();
  try {
    eventBus.emit(SERVER_EVENT.createOrderRequestAndSubscribe, {
      isPaperTrading: true, subscription: null, orderType: 'Market',
      orderRequest: {
        marketName: 'BTC_USD', side: 'buy', amount: -2,
        client_order_id: 300,
      },
    });
    eventBus.emit(SERVER_EVENT.orderCancelRequest, {
      market: 'BTC_USD', client_order_id: 300, isPaperTrading: true,
    });
    emulator.stop();
    assert.deepEqual(errors, [{
      code: REVERT_WB_ORDER_ERROR['invalid argument'], isWBError: true,
    }, {
      code: REVERT_WB_ORDER_ERROR['order not found'], isWBError: true,
    }]);
  } finally {
    emulator.stop();
    off();
  }
});
