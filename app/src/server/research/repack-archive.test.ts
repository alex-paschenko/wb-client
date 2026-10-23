// app/src/server/research/repack-archive.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeEntireBinary } from
  '../../shared/utilities/codecs/entire-binary-codec.js';
import type { MarketTick } from '../../shared/types/ticks.js';
import { readArchiveTicks } from '../utilities/archive-ticks.js';
import { storageDao, type StorageArchiveRow } from '../dao/storage.js';
import { repackArchiveMarket } from
  '../scheduler/jobs/repack-archive.job.js';

const MARKET = 'TEST_USD';

const createRow = (startedAt: number, count: number): StorageArchiveRow => {
  const ticks: MarketTick[] = Array.from({ length: count }, (_, index) => ({
    receivedAt: startedAt + index,
    price: startedAt + index,
  }));

  return {
    marketName: MARKET,
    startedAt,
    endedAt: startedAt + count - 1,
    numOfItems: count,
    data: encodeEntireBinary({
      codecName: 'ticks v1.0',
      binaryKind: 'snapshot',
      parameters: { marketName: MARKET },
      data: ticks,
    }),
  };
};

test('archive repack paginates, preserves ticks and keeps a short tail',
  async () => {
    const rows = Array.from({ length: 351 }, (_, i) =>
      createRow(1 + i * 600, 600));

    const originalRead = storageDao.getShortArchiveByMarketName;
    const originalReplace = storageDao.replaceArchiveBatch;
    const replacements: StorageArchiveRow[] = [];
    let pageReads = 0;

    storageDao.getShortArchiveByMarketName = async (
      marketName, afterEndedAt, limit,
    ) => {
      assert.equal(marketName, MARKET);
      pageReads++;
      return rows.filter((row) =>
        row.numOfItems < 100_000 &&
        (afterEndedAt === null || row.endedAt > afterEndedAt)
      ).sort((a, b) => a.endedAt - b.endedAt).slice(0, limit);
    };

    storageDao.replaceArchiveBatch = async (
      marketName, oldEndedAts, replacement,
    ) => {
      assert.equal(marketName, MARKET);
      assert.ok(replacement);
      const oldSet = new Set(oldEndedAts);
      const matches = rows.filter((row) => oldSet.has(row.endedAt));
      assert.equal(matches.length, oldEndedAts.length);
      for (const row of matches) {
        rows.splice(rows.indexOf(row), 1);
      }
      rows.push(replacement);
      replacements.push(replacement);
    };

    try {
      const result = await repackArchiveMarket(MARKET);
      assert.deepEqual(result, {
        sourceRows: 334,
        replacementRows: 2,
        ticks: 200_400,
      });
      assert.ok(pageReads >= 3);
      assert.equal(rows.length, 19);
      assert.equal(rows.filter((row) => row.numOfItems < 100_000).length, 17);
      assert.deepEqual(replacements.map((row) => row.numOfItems), [
        100_200, 100_200,
      ]);
      assert.equal(replacements[0].startedAt, 1);
      assert.equal(replacements[0].endedAt, 100_200);
      assert.equal(replacements[1].startedAt, 100_201);
      assert.equal(replacements[1].endedAt, 200_400);

      for (const row of replacements) {
        const ticks = readArchiveTicks(row.data, MARKET);
        assert.equal(ticks.length, row.numOfItems);
        assert.equal(ticks[0].receivedAt, row.startedAt);
        assert.equal(ticks.at(-1)?.receivedAt, row.endedAt);
        assert.ok(ticks.every((tick) => tick.price === tick.receivedAt));
      }

      // Running again must not touch already packed rows or the tail.
      assert.deepEqual(await repackArchiveMarket(MARKET), {
        sourceRows: 0, replacementRows: 0, ticks: 0,
      });
    } finally {
      storageDao.getShortArchiveByMarketName = originalRead;
      storageDao.replaceArchiveBatch = originalReplace;
    }
  });
