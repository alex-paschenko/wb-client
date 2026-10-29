// app/src/server/research/strategy-state-change.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  StrategyStateDao,
  strategyStateDao,
  type StrategyStateRow,
} from '../db/dao/strategy-state.js';
import type { Sql } from '../db/client.js';
import { up, down } from '../db/migrations/1793318400001_drop-strategy-state-kind.js';
import type { MigrationBuilder } from 'node-pg-migrate';
import { BaseStrategy } from '../strategies/base-strategy.js';
import { eventBus } from '../services/event-bus.js';
import { StrategyStatePersistence } from '../services/strategy-state-persistence.js';
import { SERVER_EVENT } from '../constants/events.js';
import type { StrategyRunParams, StrategyStates } from '../types/strategies.js';

test('base strategy records state, rests, and errors without kind', () => {
  class TestStrategy extends BaseStrategy<'holding'> {
    private next = 0;

    protected exec(): StrategyStates<'holding'> {
      switch (this.next++) {
        case 0:
          return { state: 'holding', action: 'continue' };
        case 1:
          return {
            state: 'holding', action: 'stop',
            stock: 3.25, money: 107.5,
          };
        case 2:
          return {
            state: 'holding', action: 'stop',
            errorCode: 1200,
          };
        default:
          return { state: 'holding', action: 'stop' };
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
    { receivedAt: 100, state: 'idle' },
    { receivedAt: 100, state: 'holding' },
    {
      receivedAt: 100, state: 'holding',
      stock: 3.25, money: 107.5,
    },
    { receivedAt: 100, state: 'holding', errorCode: 1200 },
    { receivedAt: 100, state: 'holding' },
  ]);
});

test('state DAO serializes optional fields as NULL without kind', async () => {
  let inserted: Record<string, unknown>[] = [];
  let columns: string[] = [];
  const fakeQ = (...args: unknown[]): unknown => {
    if (Array.isArray(args[0]) && typeof args[0][0] === 'object') {
      inserted = args[0] as Record<string, unknown>[];
      columns = args.slice(1) as string[];
      return 'VALUES';
    }
    return Promise.resolve([]);
  };
  const dao = new StrategyStateDao(fakeQ as unknown as Sql);
  const common = {
    marketName: 'BTC_USDT', strategyName: 'test', receivedAt: 123,
  };
  const rows: StrategyStateRow[] = [
    { ...common, stateSequence: 1, state: 'idle' },
    { ...common, stateSequence: 2, state: 'holding', errorCode: 42 },
    { ...common, stateSequence: 3, state: 'holding',
      stock: 1.75, money: 123.5 },
    { ...common, stateSequence: 4, state: 'holding',
      stock: 0, money: 0, errorCode: 0 },
  ];

  await dao.insert(rows);
  assert.deepEqual(inserted.map(row => [
    row.error_code, row.stock, row.money,
  ]), [
    [null, null, null],
    [42, null, null],
    [null, 1.75, 123.5],
    [0, 0, 0],
  ]);
  assert.equal(inserted.every(row => !('kind' in row)), true);
  assert.equal(columns.includes('kind'), false);
});

test('state persistence preserves changes and sequences', async () => {
  const originalInsert = strategyStateDao.insert;
  const rows: StrategyStateRow[] = [];
  strategyStateDao.insert = async batch => { rows.push(...batch); };
  const persistence = new StrategyStatePersistence();
  persistence.start();
  try {
    eventBus.emit(SERVER_EVENT.strategyStatePersistenceRequest, {
      changes: [
        { marketName: 'BTC_USDT', strategyName: 'test',
          receivedAt: 123, state: 'holding', errorCode: 42 },
        { marketName: 'BTC_USDT', strategyName: 'test',
          receivedAt: 123, state: 'holding',
          stock: 2.5, money: -0.125 },
      ],
    });
    await persistence.stop();
    assert.deepEqual(rows.map(r => [r.stateSequence, r.state]), [
      [1, 'holding'], [2, 'holding'],
    ]);
    assert.equal(rows[0].errorCode, 42);
    assert.equal(rows[1].stock, 2.5);
    assert.equal(rows[1].money, -0.125);
  } finally {
    await persistence.stop();
    strategyStateDao.insert = originalInsert;
  }
});

test('strategy state migration removes kind and restores it on rollback', async () => {
  const calls: unknown[][] = [];
  const pg = {
    dropColumn: (...args: unknown[]) => { calls.push(['dropColumn', ...args]); },
    addColumn: (...args: unknown[]) => { calls.push(['addColumn', ...args]); },
  } as unknown as MigrationBuilder;
  await up(pg);
  await down(pg);
  assert.deepEqual(calls, [
    ['dropColumn', 'strategy_state_history', 'kind'],
    ['addColumn', 'strategy_state_history', {
      kind: { type: 'smallint', notNull: true, default: 0 },
    }],
  ]);
});
