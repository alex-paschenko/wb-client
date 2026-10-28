// app/src/server/research/strategy-state-change.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  strategyChangeType,
  revertStrategyChangeType,
} from '../constants/strategies.js';
import {
  StrategyStateDao,
  strategyStateDao,
  type StrategyStateRow,
} from '../db/dao/strategy-state.js';
import type { Sql } from '../db/client.js';
import { BaseStrategy } from '../strategies/base-strategy.js';
import { eventBus } from '../services/event-bus.js';
import { StrategyStatePersistence } from '../services/strategy-state-persistence.js';
import { SERVER_EVENT } from '../constants/events.js';
import type { StrategyRunParams, StrategyStates } from '../types/strategies.js';

test('strategy change kinds use semantic aliases', () => {
  assert.deepEqual(strategyChangeType, {
    0: 'bare', 1: 'error', 2: 'rests',
  });
  assert.deepEqual(revertStrategyChangeType, {
    bare: 0, error: 1, rests: 2,
  });
});

test('base strategy records bare, rests and error changes', () => {
  class TestStrategy extends BaseStrategy<'holding'> {
    private next = 0;

    protected exec(): StrategyStates<'holding'> {
      switch (this.next++) {
        case 0:
          return { state: 'holding', action: 'continue', kind: 'bare' };
        case 1:
          return {
            kind: 'rests', state: 'holding', action: 'stop',
            stock: 3.25, money: 107.5,
          };
        case 2:
          return {
            kind: 'error', state: 'holding', action: 'stop',
            errorCode: 1200,
          };
        default:
          return { state: 'holding', action: 'stop', kind: 'bare' };
      }
    }
  }

  const params = {
    storage: [{ marketName: 'BTC_USDT', receivedAt: 100 }],
    orderApi: {}, depthApi: {}, stateChanges: [],
    depthHistory: null, orders: [],
  } as unknown as StrategyRunParams<'holding'>;

  const strategy = new TestStrategy('test');
  strategy.run(params);
  strategy.run(params);
  strategy.run(params);
  assert.deepEqual(params.stateChanges, [
    { kind: 'bare', receivedAt: 100, state: 'idle' },
    { kind: 'bare', receivedAt: 100, state: 'holding' },
    {
      kind: 'rests', receivedAt: 100, state: 'holding',
      stock: 3.25, money: 107.5,
    },
    { kind: 'error', receivedAt: 100, state: 'holding', errorCode: 1200 },
  ]);
});

test('state DAO serializes kind as a number and optional fields as NULL',
  async () => {
    let inserted: Record<string, unknown>[] = [];
    const fakeQ = (...args: unknown[]): unknown => {
      if (Array.isArray(args[0]) && typeof args[0][0] === 'object') {
        inserted = args[0] as Record<string, unknown>[];
        return 'VALUES';
      }
      return Promise.resolve([]);
    };
    const dao = new StrategyStateDao(fakeQ as unknown as Sql);
    const common = {
      marketName: 'BTC_USDT', strategyName: 'test', receivedAt: 123,
    };
    const rows: StrategyStateRow[] = [
      { ...common, stateSequence: 1, kind: 'bare', state: 'idle' },
      { ...common, stateSequence: 2, kind: 'error', state: 'holding',
        errorCode: 42 },
      { ...common, stateSequence: 3, kind: 'rests', state: 'holding',
        stock: 1.75, money: 123.5 },
    ];

    await dao.insert(rows);
    assert.deepEqual(inserted.map(row => [
      row.kind, row.error_code, row.stock, row.money,
    ]), [
      [revertStrategyChangeType.bare, null, null, null],
      [revertStrategyChangeType.error, 42, null, null],
      [revertStrategyChangeType.rests, null, 1.75, 123.5],
    ]);
  },
);

test('state persistence preserves discriminated changes and sequences',
  async () => {
    const originalInsert = strategyStateDao.insert;
    const rows: StrategyStateRow[] = [];
    strategyStateDao.insert = async batch => { rows.push(...batch); };
    const persistence = new StrategyStatePersistence();
    persistence.start();
    try {
      eventBus.emit(SERVER_EVENT.strategyStatePersistenceRequest, {
        changes: [
          { marketName: 'BTC_USDT', strategyName: 'test',
            kind: 'error', receivedAt: 123, state: 'holding',
            errorCode: 42 },
          { marketName: 'BTC_USDT', strategyName: 'test',
            kind: 'rests', receivedAt: 123, state: 'holding',
            stock: 2.5, money: -0.125 },
        ],
      });
      await persistence.stop();
      assert.deepEqual(rows.map(r => [r.stateSequence, r.kind]), [
        [1, 'error'], [2, 'rests'],
      ]);
      assert.equal(rows[0].kind === 'error' && rows[0].errorCode, 42);
      assert.equal(rows[1].kind === 'rests' && rows[1].stock, 2.5);
      assert.equal(rows[1].kind === 'rests' && rows[1].money, -0.125);
    } finally {
      await persistence.stop();
      strategyStateDao.insert = originalInsert;
    }
  },
);
