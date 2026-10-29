// app/src/server/scheduler/jobs/repack-archive.job.ts

import cron from 'node-cron';

import type { MarketTick } from '../../../shared/types/ticks.js';
import type { ResearchTick } from '../../../shared/types/research-storage.js';
import { decodeCodec } from '../../../shared/utilities/codecs/codecs.js';
import {
  decodeEntireBinary,
  encodeEntireBinary,
} from '../../../shared/utilities/codecs/entire-binary-codec.js';
import {
  ARCHIVE_REPACK_BATCH_SIZE,
  ARCHIVE_REPACK_PAGE_SIZE,
  RESEARCH_REPACK_BATCH_SIZE,
  RESEARCH_REPACK_PAGE_SIZE,
} from '../../constants/persistence.js';
import { storageDao, type StorageArchiveRow } from '../../db/dao/storage.js';
import { researchStorageDao, type ResearchStorageRow } from '../../db/dao/research-storage.js';
import { runJob } from '../../services/run-job.js';

let isRunning = false;

interface RepackStats {
  markets: number;
  sourceRows: number;
  replacementRows: number;
  ticks: number;
}

const readTicks = (
  row: StorageArchiveRow,
  marketName: string,
): MarketTick[] => {
  const binary = decodeEntireBinary(row.data);

  if (binary.binaryKind !== 'snapshot' ||
      binary.parameters?.marketName !== marketName) {
    throw new Error(`Invalid archive binary for ${marketName}`);
  }

  // The codec version is selected from each binary's own header.
  // Additional tick codecs can be supported here without knowing their
  // binary layouts. The write path always uses the current ticks codec.
  if (binary.codecName !== 'ticks v1.0') {
    throw new Error(`Unsupported archive codec: ${binary.codecName}`);
  }

  const ticks = decodeCodec(binary.codecName, binary.data);

  const actualStartedAt = ticks[0]?.receivedAt;
  const actualEndedAt = ticks.at(-1)?.receivedAt;

  if (ticks.length !== row.numOfItems ||
      actualStartedAt !== row.startedAt ||
      actualEndedAt !== row.endedAt) {
    throw new Error(
      `Archive metadata mismatch: ${marketName}/${row.endedAt}\n` +
      `  numOfItems: ${row.numOfItems} / ${ticks.length}\n` +
      `  startedAt:  ${row.startedAt} / ${actualStartedAt}\n` +
      `  endedAt:    ${row.endedAt} / ${actualEndedAt}`,
    );
  }

  return ticks;
};

export const repackArchiveMarket = async (
  marketName: string,
): Promise<Omit<RepackStats, 'markets'>> => {
  let cursor: number | null = null;
  let lastEndedAt: number | null = null;
  let batchStartedAt: number | null = null;
  let ticks: MarketTick[] = [];
  let oldEndedAts: number[] = [];

  const stats = { sourceRows: 0, replacementRows: 0, ticks: 0 };

  const flush = async (): Promise<void> => {
    if (ticks.length < ARCHIVE_REPACK_BATCH_SIZE) {
      return;
    }

    const replacement = {
      snapshotType: 'archive' as const,
      marketName,
      startedAt: batchStartedAt!,
      endedAt: oldEndedAts.at(-1)!,
      numOfItems: ticks.length,
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

    stats.sourceRows += oldEndedAts.length;
    stats.replacementRows++;
    stats.ticks += ticks.length;

    if (stats.replacementRows % 10 === 0) {
      console.log('Archive repack progress', { marketName, ...stats });
    }

    ticks = [];
    oldEndedAts = [];
    batchStartedAt = null;
  };

  for (;;) {
    const rows = await storageDao.getShortArchiveByMarketName(
      marketName, cursor, ARCHIVE_REPACK_PAGE_SIZE,
    );

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      if (lastEndedAt !== null && row.startedAt <= lastEndedAt) {
        throw new Error(
          `Overlapping archive boundaries: ${marketName}/${row.endedAt}`,
        );
      }

      const decoded = readTicks(row, marketName);
      batchStartedAt ??= row.startedAt;
      oldEndedAts.push(row.endedAt);
      ticks.push(...decoded);
      lastEndedAt = row.endedAt;

      await flush();
    }

    cursor = rows.at(-1)!.endedAt;
  }

  // A remainder below the threshold stays in the database unchanged.
  return stats;
};

export const repackArchive = async (): Promise<RepackStats> => {
  const markets = await storageDao.getArchiveRepackMarkets();
  const total: RepackStats = {
    markets: markets.length,
    sourceRows: 0,
    replacementRows: 0,
    ticks: 0,
  };

  console.log('Archive repack started', { markets: markets.length });

  for (const [index, { marketName, numOfItemsToRepack }] of
    markets.entries()) {
    console.log('Archive repack market', {
      marketName,
      progress: `${index + 1}/${markets.length}`,
      numOfItemsToRepack,
    });

    const stats = await repackArchiveMarket(marketName);
    total.sourceRows += stats.sourceRows;
    total.replacementRows += stats.replacementRows;
    total.ticks += stats.ticks;

    console.log('Archive repack market completed', { marketName, ...stats });
  }

  return total;
};

const readResearchTicks = (
  row: ResearchStorageRow,
  marketName: string,
): ResearchTick[] => {
  const binary = decodeEntireBinary(row.data);
  if (binary.binaryKind !== 'snapshot' ||
    binary.codecName !== 'research ticks v1.0' ||
    binary.parameters?.marketName !== marketName ||
    binary.parameters?.modelVersion !== 'forecast-v6') {
    throw new Error(`Invalid research binary for ${marketName}/${row.endedAt}`);
  }
  const ticks = decodeCodec(binary.codecName, binary.data);
  if (ticks.length !== row.numOfItems ||
    ticks[0]?.receivedAt !== row.startedAt ||
    ticks.at(-1)?.receivedAt !== row.endedAt) {
    throw new Error(`Research metadata mismatch: ${marketName}/${row.endedAt}`);
  }
  return ticks;
};

export const repackResearchMarket = async (
  marketName: string,
): Promise<Omit<RepackStats, 'markets'>> => {
  let cursor: number | null = null;
  let lastEndedAt: number | null = null;
  let batchStartedAt: number | null = null;
  let ticks: ResearchTick[] = [];
  let oldEndedAts: number[] = [];
  const stats = { sourceRows: 0, replacementRows: 0, ticks: 0 };

  const flush = async (): Promise<void> => {
    if (ticks.length < RESEARCH_REPACK_BATCH_SIZE) return;
    const replacement = {
      marketName,
      startedAt: batchStartedAt!,
      endedAt: oldEndedAts.at(-1)!,
      numOfItems: ticks.length,
      data: encodeEntireBinary({
        codecName: 'research ticks v1.0',
        binaryKind: 'snapshot',
        parameters: { marketName, modelVersion: 'forecast-v6' },
        data: ticks,
      }),
    };
    await researchStorageDao.replaceBatch(marketName, oldEndedAts, replacement);
    stats.sourceRows += oldEndedAts.length;
    stats.replacementRows++;
    stats.ticks += ticks.length;
    if (stats.replacementRows % 10 === 0) {
      console.log('Research repack progress', { marketName, ...stats });
    }
    ticks = [];
    oldEndedAts = [];
    batchStartedAt = null;
  };

  for (;;) {
    const rows = await researchStorageDao.getShortByMarketName(
      marketName, cursor, RESEARCH_REPACK_PAGE_SIZE,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      if (lastEndedAt !== null && row.startedAt <= lastEndedAt) {
        throw new Error(`Overlapping research boundaries: ${marketName}/${row.endedAt}`);
      }
      const decoded = readResearchTicks(row, marketName);
      batchStartedAt ??= row.startedAt;
      oldEndedAts.push(row.endedAt);
      ticks.push(...decoded);
      lastEndedAt = row.endedAt;
      await flush();
    }
    cursor = rows.at(-1)!.endedAt;
  }
  // Keep a short trailing batch unchanged, exactly as for the tick archive.
  return stats;
};

export const repackResearch = async (): Promise<RepackStats> => {
  const markets = await researchStorageDao.getRepackMarkets();
  const total: RepackStats = {
    markets: markets.length, sourceRows: 0, replacementRows: 0, ticks: 0,
  };
  console.log('Research repack started', { markets: markets.length });
  for (const [index, { marketName, numOfItemsToRepack }] of markets.entries()) {
    console.log('Research repack market', {
      marketName, progress: `${index + 1}/${markets.length}`, numOfItemsToRepack,
    });
    const stats = await repackResearchMarket(marketName);
    total.sourceRows += stats.sourceRows;
    total.replacementRows += stats.replacementRows;
    total.ticks += stats.ticks;
    console.log('Research repack market completed', { marketName, ...stats });
  }
  return total;
};

export const startRepackArchiveJob = (): void => {
  cron.schedule('0 3 * * *', async () => {
    if (isRunning) {
      console.warn('Archive repack skipped: previous run is active');
      return;
    }

    isRunning = true;

    try {
      try {
        const result = await runJob('repack-archive', repackArchive);
        console.log('Archive repack completed', result);
      } catch (error) {
        console.error('Archive repack failed', error);
      }
      const researchResult = await runJob('repack-research', repackResearch);
      console.log('Research repack completed', researchResult);
    } catch (error) {
      console.error('Archive repack failed', error);
    } finally {
      isRunning = false;
    }
  });
};
