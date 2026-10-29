import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Storage } from '../../shared/services/storage.js';
import { globalStateService } from '../../shared/services/global-state.js';
import type { ResearchTick } from '../../shared/types/research-storage.js';
import { decodeCodec } from '../../shared/utilities/codecs/codecs.js';
import { decodeEntireBinary, encodeEntireBinary } from
  '../../shared/utilities/codecs/entire-binary-codec.js';
import { researchStorageDao, type ResearchStorageRow } from '../db/dao/research-storage.js';
import { repackResearchMarket } from '../scheduler/jobs/repack-archive.job.js';

const MARKET = 'BTC_USDT';
const tick = (receivedAt: number): ResearchTick => ({
  receivedAt, price: 100 + receivedAt / 1000,
  emaPrice7: 100, emaLog7: 1.5, emaLog15: 1.4,
  emaLog30: 1.3, emaLog60: 1.2,
  forecast3: 0, forecast4: null, forecastCombined: -1.5,
});

const row = (items: ResearchTick[]): ResearchStorageRow => ({
  marketName: MARKET,
  startedAt: items[0].receivedAt,
  endedAt: items.at(-1)!.receivedAt,
  numOfItems: items.length,
  data: encodeEntireBinary({
    codecName: 'research ticks v1.0', binaryKind: 'snapshot',
    parameters: { marketName: MARKET, modelVersion: 'forecast-v6' },
    data: items,
  }),
});

const decode = (data: Uint8Array): ResearchTick[] => {
  const binary = decodeEntireBinary(data);
  assert.equal(binary.codecName, 'research ticks v1.0');
  assert.equal(binary.parameters?.modelVersion, 'forecast-v6');
  return decodeCodec(binary.codecName, binary.data);
};

test('research codec round trip preserves nullable forecasts and both EMA banks', () => {
  const source = [tick(1000), tick(1001)];
  assert.deepEqual(decode(row(source).data), source);
});

test('research buffer records only while subscribed and drains without losing tails', () => {
  const previous = globalStateService.getStorageEntities();
  globalStateService.setStorageEntities([]);
  const storage = new Storage(MARKET);
  storage.appendResearchTick(tick(1));
  assert.equal(storage.researchBufferLength, 0);
  storage.setResearchRecording(true);
  for (let i = 2; i <= 7; i++) storage.appendResearchTick(tick(i));
  const first = storage.getResearchSnapshot(4)!;
  assert.equal(first.numOfItems, 4);
  assert.deepEqual(decode(first.data).map((t) => t.receivedAt), [2, 3, 4, 5]);
  storage.setResearchRecording(false);
  storage.appendResearchTick(tick(8));
  assert.equal(storage.researchBufferLength, 2);
  assert.equal(storage.hasResearchFlushRequest, true);
  const last = storage.getResearchSnapshot()!;
  assert.deepEqual(decode(last.data).map((t) => t.receivedAt), [6, 7]);
  assert.equal(storage.hasResearchFlushRequest, false);
  globalStateService.setStorageEntities(previous);
});

test('research repack replaces complete batches and keeps a small tail', async () => {
  const rows = Array.from({ length: 45 }, (_, i) => row(
    Array.from({ length: 600 }, (_, j) => tick(1 + i * 600 + j)),
  ));
  const originalRead = researchStorageDao.getShortByMarketName;
  const originalReplace = researchStorageDao.replaceBatch;
  researchStorageDao.getShortByMarketName = async (marketName, cursor, limit) => {
    assert.equal(marketName, MARKET);
    return rows.filter((r) => r.numOfItems < 20_000 &&
      (cursor === null || r.endedAt > cursor))
      .sort((a, b) => a.endedAt - b.endedAt).slice(0, limit);
  };
  researchStorageDao.replaceBatch = async (marketName, oldEndedAts, replacement) => {
    assert.equal(marketName, MARKET);
    const toRemove = new Set(oldEndedAts);
    assert.equal(rows.filter((r) => toRemove.has(r.endedAt)).length, oldEndedAts.length);
    for (const existing of [...rows]) {
      if (toRemove.has(existing.endedAt)) rows.splice(rows.indexOf(existing), 1);
    }
    rows.push(replacement);
  };
  try {
    assert.deepEqual(await repackResearchMarket(MARKET), {
      sourceRows: 34, replacementRows: 1, ticks: 20_400,
    });
    const packed = rows.find((r) => r.numOfItems >= 20_000)!;
    assert.equal(decode(packed.data).length, 20_400);
    assert.equal(rows.length, 12);
    assert.deepEqual(await repackResearchMarket(MARKET), {
      sourceRows: 0, replacementRows: 0, ticks: 0,
    });
  } finally {
    researchStorageDao.getShortByMarketName = originalRead;
    researchStorageDao.replaceBatch = originalReplace;
  }
});

test('depth history v1.0 retains per-update receivedAt and arrivedAt', () => {
  const source = [{ receivedAt: 1200, arrivedAt: 1300, timestamp: 100,
    event_time: 101, bids: [[99, 1] as [number, number]], asks: [] },
  { receivedAt: 1250, arrivedAt: 1350, timestamp: 102,
    event_time: 103, bids: [], asks: [[101, 2] as [number, number]] }];
  const encoded = encodeEntireBinary({ codecName: 'order book depth history v1.0',
    binaryKind: 'snapshot', parameters: null, data: source });
  const binary = decodeEntireBinary(encoded);
  assert.equal(binary.codecName, 'order book depth history v1.0');
  assert.deepEqual(decodeCodec(binary.codecName, binary.data), source);
});
