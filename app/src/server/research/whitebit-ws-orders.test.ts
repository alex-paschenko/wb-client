// app/src/server/research/whitebit-ws-orders.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERVER_EVENT } from '../constants/events.js';
import { REVERT_ORDER_ERROR, REVERT_WB_ORDER_ERROR } from '../constants/order-error-codes.js';
import { eventBus } from '../services/event-bus.js';
import { WhitebitWsService } from '../services/whitebit-ws.js';
import {
  fromWhitebitOrder, fromWhitebitOrderError, toWhitebitOrderRequest,
} from '../whitebit/order-adapter.js';

const wireOrder = {
  id: 123, client_order_id: '9', market: 'BTC_USD',
  type: 2, side: 1, status: 'PARTIALLY_FILLED',
  price: '0', amount: '10', left: '3',
  deal_stock: '7', deal_money: '700', deal_fee: '0.7',
  ctime: 1234.123456, mtime: 1235.123456,
  post_only: false, ioc: false, stp: 'no',
  position_side: 'BOTH', rpi: false, retail: false,
  reduce_only: false,
};

test('WS adapter keeps numbers internally and strings on the wire', () => {
  const result = toWhitebitOrderRequest({
    orderType: 'Limit',
    orderRequest: {
      marketName: 'BTC_USD', side: 'buy', amount: 1e-8,
      price: 200, client_order_id: 9,
    },
  });
  assert.equal(result.method, 'order_limit_place');
  assert.deepEqual(result.params, [{
    market: 'BTC_USD', side: 'buy', amount: '0.00000001',
    price: '200', client_order_id: '9',
  }]);
  const parsed = fromWhitebitOrder(wireOrder);
  assert.equal(parsed.type, 'Market');
  assert.equal(parsed.side, 'sell');
  assert.equal(parsed.amount, 10);
  assert.equal(parsed.client_order_id, 9);
  assert.equal(parsed.mtime, 1235.123456);
});

test('WS order queue acknowledges subscriptions before placing orders', () => {
  const service = new WhitebitWsService();
  let nextRequestId = 0;
  const sends: Array<{ method: string; params: unknown[] }> = [];
  const received: unknown[] = [];
  const updated: unknown[] = [];
  const offReceipt = eventBus.on(SERVER_EVENT.orderRequestResult, e => {
    received.push(e);
  });
  const offUpdate = eventBus.on(SERVER_EVENT.orderUpdated, e => {
    updated.push(e);
  });

  // Inject a fake authenticated socket; no network, account, or keys involved.
  const local = service as unknown as {
    requireAccountAuthorization: () => void;
    wsClient: {
      isOpen: () => boolean;
      sendRequest: (method: string, params: unknown[]) => number;
      disconnect: () => void;
    };
    enqueueOrder: (command: unknown) => void;
    handleWSMessage: (message: Record<string, unknown>) => void;
  };
  local.requireAccountAuthorization = () => {};
  local.wsClient = {
    isOpen: () => true,
    disconnect: () => {},
    sendRequest: (method, params) => {
      sends.push({ method, params });
      return ++nextRequestId;
    },
  };
  try {
    const event = {
      isPaperTrading: false,
      orderType: 'Market' as const,
      orderRequest: {
        marketName: 'BTC_USD', side: 'sell' as const,
        amount: 10, client_order_id: 9,
      },
      subscription: ['BTC_USD'],
    };
    local.enqueueOrder({ kind: 'create', event });
    assert.deepEqual(sends.map(v => v.method), ['ordersPending_subscribe']);
    local.enqueueOrder({ kind: 'create', event: {
      ...event, subscription: null,
      orderRequest: { ...event.orderRequest, client_order_id: 10 },
    } });
    assert.equal(sends.length, 1);
    local.handleWSMessage({ id: 1, error: null, result: { status: 'success' } });
    assert.deepEqual(sends.map(v => v.method), [
      'ordersPending_subscribe', 'ordersExecuted_subscribe',
    ]);
    assert.deepEqual(sends[1].params, [['BTC_USD'], 0]);
    local.handleWSMessage({ id: 2, error: null,
      result: { status: 'success' } });
    assert.equal(sends[2].method, 'order_market_place');
    local.handleWSMessage({ id: 3, error: null, result: wireOrder });
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], {
      marketName: 'BTC_USD', client_order_id: 9,
      isPaperTrading: false, error: null,
    });
    assert.equal(updated.length, 0);
    assert.equal(sends.length, 4);
    assert.equal(sends[3].method, 'order_market_place');
    local.handleWSMessage({
      method: 'ordersPending_update',
      params: [3, { ...wireOrder, mtime: 1236 }],
    });
    assert.equal(updated.length, 1);
    local.handleWSMessage({
      method: 'ordersExecuted_update',
      params: [{ ...wireOrder, status: 'FILLED', mtime: 1237 }],
    });
    assert.equal(updated.length, 2);
    assert.equal((updated[1] as { eventId: number }).eventId, 3);
    local.handleWSMessage({ id: 4, error: {
      code: REVERT_WB_ORDER_ERROR['balance not enough'],
      message: 'balance not enough',
    }, result: null });
    assert.equal(received.length, 2);
    assert.deepEqual((received.at(-1) as { error: unknown }).error, {
      code: REVERT_WB_ORDER_ERROR['balance not enough'],
      isWBError: true,
    });
  } finally {
    offReceipt();
    offUpdate();
    service.stop();
  }
});

test('failed subscription prevents placement; timed-out placement is unknown',
  () => {
    const service = new WhitebitWsService();
    let nextId = 0;
    const methods: string[] = [];
    const errors: Array<{ code: number; isWBError: boolean }> = [];
    const off = eventBus.on(SERVER_EVENT.orderRequestResult, event => {
      if (event.error) errors.push(event.error);
    });
    const local = service as unknown as {
      requireAccountAuthorization: () => void;
      wsClient: {
        isOpen: () => boolean;
        sendRequest: (method: string, params: unknown[]) => number;
        disconnect: () => void;
      };
      enqueueOrder: (command: unknown) => void;
      handleWSMessage: (message: Record<string, unknown>) => void;
      handleOrderRequestTimeout: (id: number) => void;
    };
    local.requireAccountAuthorization = () => {};
    local.wsClient = {
      isOpen: () => true,
      disconnect: () => {},
      sendRequest: method => { methods.push(method); return ++nextId; },
    };
    const event = {
      orderType: 'Market' as const, isPaperTrading: false,
      subscription: ['BTC_USD'],
      orderRequest: {
        marketName: 'BTC_USD', side: 'sell' as const,
        amount: 10, client_order_id: 100,
      },
    };
    try {
      local.enqueueOrder({ kind: 'create', event });
      local.handleWSMessage({ id: 1, result: null,
        error: { code: REVERT_WB_ORDER_ERROR['balance not enough'],
          message: 'balance not enough' } });
      assert.deepEqual(methods, ['ordersPending_subscribe']);
      assert.deepEqual(errors, [{
        code: REVERT_ORDER_ERROR['order subscription failed'],
        isWBError: false,
      }]);
    } finally {
      service.stop();
    }

    const second = new WhitebitWsService();
    const next = second as unknown as typeof local;
    next.requireAccountAuthorization = () => {};
    next.wsClient = {
      isOpen: () => true,
      disconnect: () => {},
      sendRequest: method => { methods.push(method); return ++nextId; },
    };
    try {
      next.enqueueOrder({ kind: 'create', event });
      next.handleWSMessage({ id: 2, error: null,
        result: { status: 'success' } });
      next.handleWSMessage({ id: 3, error: null,
        result: { status: 'success' } });
      next.handleOrderRequestTimeout(4);
      assert.deepEqual(errors.at(-1), {
        code: REVERT_ORDER_ERROR['order outcome unknown'],
        isWBError: false,
      });
      assert.equal(methods.at(-1), 'order_market_place');
    } finally {
      second.stop();
      off();
    }
  });


test('WS error adapter accepts numeric codes only', () => {
  assert.deepEqual(fromWhitebitOrderError({
    code: REVERT_WB_ORDER_ERROR['balance not enough'],
    message: 'This text is not persisted',
  }), {
    code: REVERT_WB_ORDER_ERROR['balance not enough'],
    isWBError: true,
  });
  assert.throws(() => fromWhitebitOrderError({ code: '10' }),
    /Invalid WhiteBIT order error code/);
  assert.throws(() => fromWhitebitOrderError({ code: 1.5 }),
    /Invalid WhiteBIT order error code/);
});
