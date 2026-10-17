import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERVER_EVENT } from '../constants/events.js';
import { eventBus } from '../services/event-bus.js';
import { WhitebitWsService } from '../services/whitebit-ws.js';
import type { RawOrderBookDepth } from '../types/order-book-depth.js';

test('depth remains market-scoped, enforces the transport chain and forwards params unchanged', () => {
  const service = new WhitebitWsService();
  const calls: { id: number; method: string; params: unknown[] }[] = [];
  const client = {
    isOpen: () => true,
    sendRequest: (method: string, params: unknown[]) => {
      const id = calls.length + 1;
      calls.push({ id, method, params });
      return id;
    },
    reconnect: () => { throw new Error('Unexpected reconnect'); },
  };
  const target = service as unknown as {
    wsClient: typeof client;
    handleDepthSubscriptionEvent: (event: {
      marketName: string; action: 'subscribe' | 'unsubscribe';
    }) => void;
    handleWSMessage: (message: Record<string, unknown>) => void;
    depthSubscriptions: Map<string, unknown>;
  };
  target.wsClient = client;
  const updates: RawOrderBookDepth[] = [];
  const off = eventBus.on(SERVER_EVENT.orderBookDepthUpdate,
    (params) => { updates.push(params); });
  try {
    const command = (marketName: string, action: 'subscribe' | 'unsubscribe') =>
      target.handleDepthSubscriptionEvent({ marketName, action });
    const receipt = (id: number) => target.handleWSMessage({ id,
      result: { status: 'success' }, error: null });
    const send = (params: RawOrderBookDepth) =>
      target.handleWSMessage({ method: 'depth_update', params });

    command('BTC_USDT', 'subscribe');
    command('ETH_USDT', 'subscribe');
    assert.deepEqual(calls.map((call) => call.params), [
      ['BTC_USDT', 20, '0', true], ['ETH_USDT', 20, '0', true],
    ]);
    receipt(1); receipt(2);
    const full: RawOrderBookDepth = [true, {
      timestamp: 1, event_time: 1, asks: [['101', '1']],
      bids: [['99', '2']], update_id: 42,
    }, 'BTC_USDT'];
    send(full);
    assert.equal(updates[0], full);
    const delta: RawOrderBookDepth = [false, {
      timestamp: 2, event_time: 2, asks: [['101', '0']],
      bids: [], update_id: 50, past_update_id: 42,
    }, 'BTC_USDT'];
    send(delta); // update_id need not be consecutive, past_update_id must match.
    assert.equal(updates[1], delta);
    const keepalive: RawOrderBookDepth = [true, {
      ...full[1], update_id: 200,
    }, 'BTC_USDT'];
    send(keepalive); // Full keepalive may jump ahead without a gap.
    send([false, { ...delta[1], past_update_id: 200, update_id: 205 },
      'BTC_USDT']);
    assert.equal(updates.length, 4);
    send([false, { ...delta[1], past_update_id: 204, update_id: 206 },
      'BTC_USDT']);
    assert.equal(updates.length, 4);
    assert.deepEqual(calls.at(-1), {
      id: 3, method: 'depth_unsubscribe', params: ['BTC_USDT'],
    });
    assert.ok(target.depthSubscriptions.has('ETH_USDT'));
    receipt(3);
    assert.deepEqual(calls.at(-1), {
      id: 4, method: 'depth_subscribe',
      params: ['BTC_USDT', 20, '0', true],
    });
    send(delta); // Ignore deltas until a new snapshot arrives.
    assert.equal(updates.length, 4);
    receipt(4);
    send([true, { ...full[1], update_id: 70 }, 'BTC_USDT']);
    assert.equal(updates.length, 5);
    command('BTC_USDT', 'unsubscribe');
    assert.deepEqual(calls.at(-1)?.params, ['BTC_USDT']);
    receipt(5);
    assert.equal(target.depthSubscriptions.has('BTC_USDT'), false);
    assert.equal(target.depthSubscriptions.has('ETH_USDT'), true);
  } finally {
    off();
    for (const state of target.depthSubscriptions.values()) {
      const timeout = (state as { timeout: ReturnType<typeof setTimeout> | null }).timeout;
      if (timeout) clearTimeout(timeout);
    }
  }
});
