// Run from app with the application stopped:
// node --import tsx src/server/scripts/repack.ts
import 'dotenv/config';

import { CANDLE_NAME } from '../../shared/constants/storage-entities.js';
import type { MarketTick } from '../../shared/types/ticks.js';
import { binaryCodec, decodeCodec } from '../../shared/utilities/codecs/codecs.js';
import {
  decodeEntireBinary,
  encodeEntireBinary,
} from '../../shared/utilities/codecs/entire-binary-codec.js';
import { storageDao, type StorageArchiveRow } from '../dao/storage.js';
import { q } from '../db/client.js';
import { CandleEntity } from '../entities/candles/candle.js';

const BATCH_SIZE = 100_000;
const CANDLE_ENTITIES = [new CandleEntity().descriptor];

function* readLegacyTicks(
  row: StorageArchiveRow,
): Generator<MarketTick> {
  const entire = decodeEntireBinary(row.data);

  if (entire.codecName !== 'snapshot v1.0' ||
      entire.binaryKind !== 'snapshot' ||
      entire.parameters?.marketName !== row.marketName) {
    throw new Error(`Unexpected archive format in ${row.marketName}`);
  }

  const { chunkSets } = decodeCodec(
    'snapshot v1.0',
    entire.data,
    { entities: CANDLE_ENTITIES },
  );
  const candleCodec = binaryCodec('candle v1.0');

  for (const chunkSet of chunkSets) {
    const chunk = chunkSet.chunks.candles[CANDLE_NAME];

    if (!chunk) {
      throw new Error(`Candle missing in ${row.marketName}`);
    }

    for (let index = 0; index < chunkSet.size; index++) {
      const { receivedAt, price } =
        candleCodec.readByItemIndex(index, chunk.view);

      if (!Number.isSafeInteger(receivedAt)) {
        throw new Error(`Invalid receivedAt in ${row.marketName}`);
      }

      yield { receivedAt, price };
    }
  }
}

const repackMarket = async (marketName: string): Promise<void> => {
  let cursor = 0;
  const seen = new Set<number>();
  let ticks: MarketTick[] = [];
  let oldEndedAts: number[] = [];
  let batchStartedAt: number | null = null;
  let converted = 0;
  let duplicates = 0;

  const flush = async (): Promise<void> => {
    if (!oldEndedAts.length) return;

    ticks.sort((a, b) => a.receivedAt - b.receivedAt);

    const replacement = ticks.length === 0 ? null : {
      marketName,
      startedAt: batchStartedAt!,
      endedAt: oldEndedAts.at(-1)!,
      data: encodeEntireBinary({
        codecName: 'ticks v1.0',
        binaryKind: 'snapshot',
        parameters: { marketName },
        data: ticks,
      }),
    };

    await storageDao.replaceArchiveBatch(
      marketName, oldEndedAts, replacement,
    );

    converted += oldEndedAts.length;
    console.log(marketName, {
      converted,
      writtenTicks: ticks.length,
      duplicates,
      through: cursor,
    });
    ticks = [];
    oldEndedAts = [];
    batchStartedAt = null;
  };

  for (;;) {
    const [row] = await storageDao.getArchiveByMarketName(
      marketName, cursor, 1,
    );

    if (!row) break;
    cursor = row.endedAt;
    const entire = decodeEntireBinary(row.data);

    if (entire.codecName === 'ticks v1.0') {
      await flush();

      if (entire.binaryKind !== 'snapshot' ||
          entire.parameters?.marketName !== marketName) {
        throw new Error(`Invalid tick binary kind: ${marketName}`);
      }

      const existing = decodeCodec('ticks v1.0', entire.data);

      for (const tick of existing) {
        seen.add(tick.receivedAt);
      }
      continue;
    }

    for (const tick of readLegacyTicks(row)) {
      if (seen.has(tick.receivedAt)) {
        duplicates++;
        continue;
      }

      seen.add(tick.receivedAt);
      ticks.push(tick);
    }

    batchStartedAt ??= row.startedAt;
    oldEndedAts.push(row.endedAt);

    if (ticks.length >= BATCH_SIZE) {
      await flush();
    }
  }

  await flush();
  seen.clear();
  console.log(`Finished ${marketName}: ${converted} legacy rows, ` +
    `${duplicates} duplicate ticks`);
};

const main = async (): Promise<void> => {
  try {
    const marketNames = await storageDao.getArchiveMarketNames();
    const selectedMarket = process.env.REPACK_MARKET_NAME;

    if (selectedMarket && !marketNames.includes(selectedMarket)) {
      throw new Error(`Archive market not found: ${selectedMarket}`);
    }

    const names = selectedMarket ? [selectedMarket] : marketNames;

    for (const [index, marketName] of names.entries()) {
      console.log(`Market ${index + 1}/${names.length}: ${marketName}`);
      await repackMarket(marketName);
    }
  } finally {
    await q.end();
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
