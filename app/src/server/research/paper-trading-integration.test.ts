import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CANDLE_NAME, MARKET_FORECAST_NAME } from '../../shared/constants/storage-entities.js';
import { globalStateService } from '../../shared/services/global-state.js';
import type { Market } from '../../shared/types/market.js';
import { decodeEntireBinary } from '../../shared/utilities/codecs/entire-binary-codec.js';
import { decodeCodec } from '../../shared/utilities/codecs/codecs.js';
import { SERVER_EVENT } from '../constants/events.js';
import { orderBookDepthDao, type DepthRow } from '../db/dao/order-book-depth.js';
import { orderReceiptsDao, type OrderReceiptRow } from '../db/dao/order-receipts.js';
import { strategyStateDao, type StrategyStateRow } from '../db/dao/strategy-state.js';
import { OrderEmulator } from './order-emulator.js';
import { eventBus } from '../services/event-bus.js';
import { DepthPersistenceService } from '../services/depth-persistence.js';
import { orderBookDepthService } from '../services/order-book-depth.js';
import { orderManager } from '../services/order-manager.js';
import { OrderPersistence } from '../services/order-persistence.js';
import { sequencesPersistence } from '../services/sequences-persistence.js';
import { StrategyManager } from '../services/strategy-manager.js';
import { StrategyStatePersistence } from '../services/strategy-state-persistence.js';
import { OneMarketTwoDeals } from '../strategies/one-market-two-deals.js';

const template: Market = {
  name: 'BTC_USDT', stock: 'BTC', money: 'USDT', type: 'spot',
  stockPrec: 8, moneyPrec: 8, feePrec: 4,
  makerFee: 0.001, takerFee: 0.001,
  minAmount: 0.0001, minTotal: 0.00001, maxTotal: 0,
  tradesEnabled: true, isActive: true,
  isCollateral: false, isTradFiFutures: false,
  tickSize: null, stepSize: null, delistedAt: null,
};

const strategyParams = {
  longCandidateTreshold: 2.25,
  shortCandidateTreshold: -2.25,
  longReturnToIdleTreshold: 2,
  shortReturnToIdleTreshold: -2,
  longOpenDealTreshold: 2.5,
  shortOpenDealTreshold: -2.5,
  longCloseDealTreshold: -1.5,
  shortCloseDealTreshold: 1.5,
};

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for paper order execution');
};

for (const { stock, money, price, openingForecast } of [
  { stock: 'BTC', money: 'USDT', price: 100, openingForecast: 3 },
  { stock: 'USDT', money: 'BTC', price: 0.01, openingForecast: -3 },
]) {
  test(`paper ${stock}_${money} completes two market deals and persists receipts, states, depth`, async () => {
    const marketName = `${stock}_${money}`;
    globalStateService.setMarketData({
      [marketName]: { ...template, name: marketName, stock, money },
    }, {
      [marketName]: {
        makerFeeRatio: 0.001, takerFeeRatio: 0.001,
        rpiMakerFeePremiumRatio: null,
      },
    });

    const receiptRows: OrderReceiptRow[] = [];
    const stateRows: StrategyStateRow[] = [];
    const depthRows: DepthRow[] = [];
    const originalReceiptInsert = orderReceiptsDao.insert;
    const originalStateInsert = strategyStateDao.insert;
    const originalDepthInsert = orderBookDepthDao.insert;
    const originalNextId = sequencesPersistence.getNextOrderId;
    orderReceiptsDao.insert = async rows => { receiptRows.push(...rows); };
    strategyStateDao.insert = async rows => { stateRows.push(...rows); };
    orderBookDepthDao.insert = async rows => { depthRows.push(...rows); };
    let nextId = 100;
    sequencesPersistence.getNextOrderId = async () => ++nextId;

    const strategy = new OneMarketTwoDeals(strategyParams);
    const strategyManager = new StrategyManager([strategy]);
    const emulator = new OrderEmulator();
    const orderPersistence = new OrderPersistence();
    const strategyPersistence = new StrategyStatePersistence();
    const depthPersistence = new DepthPersistenceService();
    const deals: Array<{ side: string; deal_stock: number; deal_money: number }> = [];
    const off = eventBus.on(SERVER_EVENT.orderUpdated, ({ order, isPaperTrading }) => {
      if (isPaperTrading && order.market === marketName) {
        deals.push({ side: order.side, deal_stock: order.deal_stock,
          deal_money: order.deal_money });
      }
    });

    orderManager.start();
    orderBookDepthService.start();
    emulator.start();
    orderPersistence.start();
    strategyPersistence.start();
    depthPersistence.start();
    strategyManager.start();

    const runTick = (receivedAt: number, signal: number) => {
      const forecast = {
        expectedResidual1m3Ema: signal,
        expectedResidual1m4Ema: signal,
        expectedResidual1mCombined: signal,
      };
      const completed: Array<{ error?: unknown }> = [];
      const unsubscribe = eventBus.on(SERVER_EVENT.strategiesCompleted,
        result => { if (result.marketName === marketName) completed.push(result); });
      try {
        eventBus.emit(SERVER_EVENT.runStrategiesRequest, {
          marketName, size: 1, endedAt: receivedAt,
          accessors: {
            indicators: { [MARKET_FORECAST_NAME]: { get: () => forecast } },
            candles: { [CANDLE_NAME]: { get: () => ({ price }) } },
          } as never,
        });
      } finally {
        unsubscribe();
      }
      assert.equal(completed.length, 1);
      assert.equal(completed[0].error, undefined);
    };

    try {
      runTick(1000, openingForecast);
      eventBus.emit(SERVER_EVENT.orderBookDepthUpdate, [
        true, {
          timestamp: 1, event_time: 1, update_id: 1,
          bids: [[String(price), '200000']],
          asks: [[String(price), '200000']],
        }, marketName,
      ]);
      await waitUntil(() => deals.length >= 1);
      await orderManager.waitForPendingRequests();
      runTick(2000, -openingForecast);
      await waitUntil(() => deals.length >= 2);
      await orderManager.waitForPendingRequests();
      assert.deepEqual(deals.map(({ side }) => side),
        openingForecast > 0 ? ['buy', 'sell'] : ['sell', 'buy']);
    } finally {
      strategyManager.stop();
      orderManager.stop();
      emulator.stop();
      orderBookDepthService.stop();
      off();
      await Promise.all([
        orderPersistence.stop(), strategyPersistence.stop(), depthPersistence.stop(),
      ]);
      orderReceiptsDao.insert = originalReceiptInsert;
      strategyStateDao.insert = originalStateInsert;
      orderBookDepthDao.insert = originalDepthInsert;
      sequencesPersistence.getNextOrderId = originalNextId;
    }

    assert.ok(stateRows.some(row => row.state === 'holding'));
    assert.equal(stateRows.at(-1)?.state, 'idle');
    assert.ok(stateRows.every(row => [1000, 2000].includes(row.receivedAt)));
    assert.ok(receiptRows.some(row => row.receivedAt === 1000));
    assert.ok(receiptRows.some(row => row.receivedAt === 2000));
    const finished = receiptRows.filter(row => {
      const binary = decodeEntireBinary(row.data);
      assert.equal(binary.codecName, 'order receipt v1.0');
      const receipt = decodeCodec(binary.codecName, binary.data);
      return receipt.isFinalized;
    });
    assert.equal(finished.length, 2, 'both executed orders must reach the DAO');
    assert.equal(depthRows.length, 1);
    const depthBinary = decodeEntireBinary(depthRows[0].data);
    assert.equal(depthBinary.codecName, 'order book depth history v1.0');
    const history = decodeCodec(depthBinary.codecName, depthBinary.data);
    assert.equal(history[0].receivedAt, 1000);
    assert.equal(depthRows[0].receivedAt, 1000);
  });
}

test('aggregation keeps strategies disabled and flushes research to persistence', async () => {
  const { StorageAggregationService } = await import('../services/storage-aggregation.js');
  const { ResearchPersistenceService } = await import('../services/research-persistence.js');
  const { researchStorageDao } = await import('../db/dao/research-storage.js');
  const { encodeEntireBinary } = await import(
    '../../shared/utilities/codecs/entire-binary-codec.js');
  const marketName = 'BTC_USDT';
  const rows: Array<{ data: Uint8Array; endedAt: number }> = [];
  const originalInsert = researchStorageDao.insert;
  researchStorageDao.insert = async snapshots => { rows.push(...snapshots); };
  const persistence = new ResearchPersistenceService();
  const researchTicks: Array<{ receivedAt: number; price: number }> = [];
  let lastTick = { receivedAt: 0, price: 0 };
  let cleared = false;
  let strategyRequests = 0;
  const off = eventBus.on(SERVER_EVENT.runStrategiesRequest, () => {
    strategyRequests++;
  });
  const storage = {
    size: 0,
    endedAt: null as number | null,
    isResearchRecording: true,
    get researchBufferLength() { return researchTicks.length; },
    initDelta() {},
    addItem(_level: number, _startedAt: number, endedAt: number,
      values: { candles: Record<string, { receivedAt: number; price: number }> }) {
      this.endedAt = endedAt;
      this.size++;
      lastTick = values.candles[CANDLE_NAME];
    },
    getBinaryDelta() { return null; },
    getAccessors() {
      return {
        candles: { [CANDLE_NAME]: { get: () => lastTick } },
        indicators: new Proxy({}, { get(_obj, name) {
          if (name === MARKET_FORECAST_NAME) {
            return { get: () => ({
              expectedResidual1m3Ema: 3,
              expectedResidual1m4Ema: 2,
              expectedResidual1mCombined: 2.5,
            }) };
          }
          return { get: () => 1.5 };
        } }),
      };
    },
    clearAccessors() { cleared = true; },
    appendResearchTick(tick: { receivedAt: number; price: number }) {
      researchTicks.push(tick);
    },
    getResearchSnapshot() {
      const ticks = researchTicks.splice(0);
      if (ticks.length === 0) return null;
      return {
        marketName,
        startedAt: ticks[0].receivedAt,
        endedAt: ticks.at(-1)!.receivedAt,
        numOfItems: ticks.length,
        data: encodeEntireBinary({
          codecName: 'research ticks v1.0', binaryKind: 'snapshot',
          parameters: { marketName, modelVersion: 'forecast-v6' },
          data: ticks.map(tick => ({ ...tick,
            emaPrice7: 1.5, emaLog7: 1.5, emaLog15: 1.5,
            emaLog30: 1.5, emaLog60: 1.5,
            forecast3: 3, forecast4: 2, forecastCombined: 2.5,
          })),
        }),
      };
    },
  };
  const aggregation = new StorageAggregationService();
  type TestAggregation = {
    getOrCreateStorage(): Promise<unknown>;
    recalculateEntities(): Promise<void>;
    aggregateLevel(): boolean;
    trimMaxLevel(): void;
    processTick(marketName: string, tick: { receivedAt: number; price: number }): Promise<void>;
    flushResearchSnapshot(storage: unknown): void;
  };
  const testable = aggregation as unknown as TestAggregation;
  testable.getOrCreateStorage = async () => storage;
  testable.recalculateEntities = async () => {};
  testable.aggregateLevel = () => false;
  testable.trimMaxLevel = () => {};
  persistence.start();
  try {
    await testable.processTick(marketName, { receivedAt: 3000, price: 101 });
    assert.equal(strategyRequests, 0, 'strategies must stay disabled by default');
    assert.equal(cleared, true);
    assert.deepEqual(researchTicks.map(t => t.receivedAt), [3000]);
    testable.flushResearchSnapshot(storage);
    await persistence.stop();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].endedAt, 3000);
    const binary = decodeEntireBinary(rows[0].data);
    assert.equal(binary.codecName, 'research ticks v1.0');
    const ticks = decodeCodec(binary.codecName, binary.data);
    assert.deepEqual(ticks.map(t => [t.receivedAt, t.price]), [[3000, 101]]);
    assert.equal(ticks[0].forecastCombined, 2.5);
  } finally {
    await persistence.stop();
    researchStorageDao.insert = originalInsert;
    off();
  }
});
