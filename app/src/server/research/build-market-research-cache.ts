// app/src/server/research/build-market-research-cache.ts
//
// Builds a normalized local research dataset from storage_archive.
// The cache intentionally contains only archived raw market observations:
// market metadata plus (market_id, received_at, price).
//
// Archive snapshots are processed newest-first. For each market,
// receivedAt values already seen in newer snapshots are skipped before
// SQLite, so the newest archived value wins without repeated conflict
// writes.
//
// Run from app:
//   node --import tsx src/server/research/build-market-research-cache.ts
//
// Optional environment variables:
//   MRC_OUTPUT_DIR=research-output/market-research-cache
//   MRC_MAX_SNAPSHOT_MB=64
//   MRC_SQLITE_BATCH_SIZE=20000
//   MRC_OVERWRITE=1

import 'dotenv/config';

import { execFileSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';

import {
  CANDLE_NAME,
} from '../../shared/constants/storage-entities.js';
import { Storage } from '../../shared/services/storage.js';
import type {
  MarketCandle,
} from '../../shared/types/data-types.js';
import type {
  Market,
} from '../../shared/types/market.js';
import type {
  LazyArray,
} from '../../shared/utilities/lazy-array.js';
import {
  decodeEntireBinary,
} from '../../shared/utilities/codecs/entire-binary-codec.js';
import { decodeCodec } from '../../shared/utilities/codecs/codecs.js';
import type { MarketTick } from '../../shared/types/ticks.js';
import { q } from '../db/client.js';
import { entityManager } from '../services/entity-manager.js';
import {
  serverGlobalStateService,
} from '../services/global-state.js';

const SCHEMA_VERSION = 1;

const OUTPUT_DIRECTORY = resolve(
  process.env.MRC_OUTPUT_DIR ??
    'research-output/market-research-cache',
);

const MAX_SNAPSHOT_BYTES =
  integer('MRC_MAX_SNAPSHOT_MB', 64, 1, 4096) * 1024 ** 2;

const SQLITE_BATCH_SIZE =
  integer('MRC_SQLITE_BATCH_SIZE', 20_000, 1, 1_000_000);

const OVERWRITE = process.env.MRC_OVERWRITE === '1';

type ArchiveSummaryRow = {
  firstEndedAt: unknown;
  lastEndedAt: unknown;
  snapshotCount: unknown;
  largestSnapshotBytes: unknown;
};

type ArchiveSnapshotRow = {
  endedAt: unknown;
  data: Uint8Array;
};

type MarketWithId = Market & {
  id: number;
};

type MarketStats = {
  marketId: number;

  snapshotCount: number;
  sourceObservationCount: number;
  observationCount: number;
  duplicateCount: number;
  rejectedCount: number;

  firstReceivedAt: number | null;
  lastReceivedAt: number | null;

  firstSnapshotEndedAt: number | null;
  lastSnapshotEndedAt: number | null;
};

type ExtractionTotals = {
  processedSnapshots: number;
  sourceObservations: number;
  observations: number;
  duplicates: number;
  rejected: number;
};

function integer(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(process.env[name] ?? fallback);

  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(
      `${name}: expected integer in [${min}, ${max}]`,
    );
  }

  return value;
}

function safeInteger(
  value: unknown,
  name: string,
): number {
  const number = Number(value);

  if (!Number.isSafeInteger(number)) {
    throw new Error(`${name}: expected a safe integer`);
  }

  return number;
}

function nullableBoolean(
  value: boolean | null | undefined,
): number | null {
  return value == null ? null : Number(value);
}

function formatFileTimestamp(timestamp: number): string {
  return new Date(timestamp)
    .toISOString()
    .replace('T', '_')
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll(':', '-');
}

function getGitCommit(): string {
  try {
    return execFileSync(
      'git',
      ['rev-parse', 'HEAD'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
  } catch {
    return 'unknown';
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA user_version = ${SCHEMA_VERSION};
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -262144;

    CREATE TABLE markets (
      id INTEGER PRIMARY KEY,

      name TEXT NOT NULL UNIQUE,
      stock TEXT NOT NULL,
      money TEXT NOT NULL,

      stock_prec INTEGER NOT NULL,
      money_prec INTEGER NOT NULL,
      fee_prec INTEGER NOT NULL,

      maker_fee REAL NOT NULL,
      taker_fee REAL NOT NULL,

      min_amount REAL NOT NULL,
      min_total REAL NOT NULL,

      trades_enabled INTEGER NOT NULL,
      is_active INTEGER NOT NULL,

      type TEXT NOT NULL,

      max_total REAL,
      is_collateral INTEGER
    );

    CREATE TABLE observations (
      market_id INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      price REAL NOT NULL,

      PRIMARY KEY (market_id, received_at)
    ) WITHOUT ROWID;

    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE market_cache_stats (
      market_id INTEGER PRIMARY KEY,

      snapshot_count INTEGER NOT NULL,
      source_observation_count INTEGER NOT NULL,
      observation_count INTEGER NOT NULL,
      duplicate_count INTEGER NOT NULL,
      rejected_count INTEGER NOT NULL,

      first_received_at INTEGER,
      last_received_at INTEGER,

      first_snapshot_ended_at INTEGER,
      last_snapshot_ended_at INTEGER
    );

    CREATE VIEW observations_readable AS
    SELECT
      m.name AS market,
      datetime(
        o.received_at / 1000.0,
        'unixepoch'
      ) AS received_at_utc,
      o.received_at,
      o.price
    FROM observations o
    JOIN markets m
      ON m.id = o.market_id;

    CREATE VIEW market_cache_stats_readable AS
    SELECT
      m.name AS market,

      s.snapshot_count,
      s.source_observation_count,
      s.observation_count,
      s.duplicate_count,
      s.rejected_count,

      datetime(
        s.first_received_at / 1000.0,
        'unixepoch'
      ) AS first_received_at_utc,

      datetime(
        s.last_received_at / 1000.0,
        'unixepoch'
      ) AS last_received_at_utc,

      datetime(
        s.first_snapshot_ended_at / 1000.0,
        'unixepoch'
      ) AS first_snapshot_ended_at_utc,

      datetime(
        s.last_snapshot_ended_at / 1000.0,
        'unixepoch'
      ) AS last_snapshot_ended_at_utc

    FROM market_cache_stats s
    JOIN markets m
      ON m.id = s.market_id;
  `);
}

class ObservationWriter {
  private transactionOpen = false;
  private pending = 0;

  public constructor(
    private readonly db: DatabaseSync,
    private readonly insert: StatementSync,
  ) {}

  public write(
    marketId: number,
    receivedAt: number,
    price: number,
  ): void {
    if (!this.transactionOpen) {
      this.db.exec('BEGIN');
      this.transactionOpen = true;
    }

    this.insert.run(
      marketId,
      receivedAt,
      price,
    );

    this.pending++;

    if (this.pending >= SQLITE_BATCH_SIZE) {
      this.commit();
    }
  }

  public flush(): void {
    if (this.transactionOpen) {
      this.commit();
    }
  }

  public rollback(): void {
    if (!this.transactionOpen) {
      return;
    }

    this.db.exec('ROLLBACK');

    this.transactionOpen = false;
    this.pending = 0;
  }

  private commit(): void {
    this.db.exec('COMMIT');

    this.transactionOpen = false;
    this.pending = 0;
  }
}

function insertMarket(
  statement: StatementSync,
  market: MarketWithId,
): void {
  statement.run(
    market.id,

    market.name,
    market.stock,
    market.money,

    market.stockPrec,
    market.moneyPrec,
    market.feePrec,

    market.makerFee,
    market.takerFee,

    market.minAmount,
    market.minTotal,

    Number(market.tradesEnabled),
    Number(market.isActive),

    market.type,

    market.maxTotal ?? null,
    nullableBoolean(market.isCollateral),
  );
}

function writeMetadata(
  db: DatabaseSync,
  values: Record<string, string | number>,
): void {
  const insert = db.prepare(`
    INSERT INTO metadata (
      key,
      value
    )
    VALUES (?, ?)
  `);

  db.exec('BEGIN');

  try {
    for (const [key, value] of Object.entries(values)) {
      insert.run(
        key,
        String(value),
      );
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  await mkdir(
    OUTPUT_DIRECTORY,
    { recursive: true },
  );

  const temporaryDirectory = await mkdtemp(
    resolve(OUTPUT_DIRECTORY, '.building-'),
  );

  const temporaryPath = resolve(
    temporaryDirectory,
    'cache.sqlite',
  );

  const db = new DatabaseSync(temporaryPath);

  createSchema(db);

  const insertMarketStatement = db.prepare(`
    INSERT INTO markets (
      id,
      name,
      stock,
      money,
      stock_prec,
      money_prec,
      fee_prec,
      maker_fee,
      taker_fee,
      min_amount,
      min_total,
      trades_enabled,
      is_active,
      type,
      max_total,
      is_collateral
    )
    VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  const insertObservationStatement = db.prepare(`
    INSERT INTO observations (
      market_id,
      received_at,
      price
    )
    VALUES (?, ?, ?)
  `);

  const insertStatsStatement = db.prepare(`
    INSERT INTO market_cache_stats (
      market_id,
      snapshot_count,
      source_observation_count,
      observation_count,
      duplicate_count,
      rejected_count,
      first_received_at,
      last_received_at,
      first_snapshot_ended_at,
      last_snapshot_ended_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const writer = new ObservationWriter(
    db,
    insertObservationStatement,
  );

  let finalPath: string | null = null;
  let completed = false;

  serverGlobalStateService.start();
  entityManager.start();

  try {
    await q.begin(async (sql) => {
      await sql`
        SET TRANSACTION
        ISOLATION LEVEL REPEATABLE READ,
        READ ONLY
      `;

      const [summary] = await sql<ArchiveSummaryRow[]>`
        SELECT
          min(ended_at) AS "firstEndedAt",
          max(ended_at) AS "lastEndedAt",
          count(*) AS "snapshotCount",
          coalesce(
            max(octet_length(data)),
            0
          ) AS "largestSnapshotBytes"
        FROM storage_archive
      `;

      if (!summary) {
        throw new Error(
          'Could not read storage_archive summary',
        );
      }

      const firstEndedAt = safeInteger(
        summary.firstEndedAt,
        'storage_archive.min(ended_at)',
      );

      const lastEndedAt = safeInteger(
        summary.lastEndedAt,
        'storage_archive.max(ended_at)',
      );

      const sourceSnapshotCount = safeInteger(
        summary.snapshotCount,
        'storage_archive.count(*)',
      );

      const largestSnapshotBytes = safeInteger(
        summary.largestSnapshotBytes,
        'storage_archive.max(octet_length(data))',
      );

      if (largestSnapshotBytes > MAX_SNAPSHOT_BYTES) {
        throw new Error(
          'Snapshot exceeds MRC_MAX_SNAPSHOT_MB: ' +
          `${largestSnapshotBytes} bytes`,
        );
      }

      const filename =
        'market-research-cache_endedAt-' +
        formatFileTimestamp(lastEndedAt) +
        '.sqlite';

      finalPath = resolve(
        OUTPUT_DIRECTORY,
        filename,
      );

      if (
        !OVERWRITE &&
        await pathExists(finalPath)
      ) {
        throw new Error(
          `Output already exists: ${finalPath}. ` +
          'Set MRC_OVERWRITE=1 to replace it.',
        );
      }

      const archivedNames =
        await sql<{ name: string }[]>`
          SELECT DISTINCT
            market_name AS name
          FROM storage_archive
          ORDER BY market_name
        `;

      if (!archivedNames.length) {
        throw new Error(
          'storage_archive is empty',
        );
      }

      const marketRows =
        await sql<{ market: Market }[]>`
          SELECT json_build_object(
            'name', name,
            'stock', stock,
            'money', money,
            'stockPrec', stock_prec,
            'moneyPrec', money_prec,
            'feePrec', fee_prec,
            'makerFee', maker_fee,
            'takerFee', taker_fee,
            'minAmount', min_amount,
            'minTotal', min_total,
            'tradesEnabled', trades_enabled,
            'isActive', is_active,
            'type', type,
            'maxTotal', max_total,
            'isCollateral', is_collateral
          ) AS market
          FROM markets
          WHERE name = ANY(
            ${archivedNames.map(
              (row) => row.name,
            )}::text[]
          )
          ORDER BY name
        `;

      const markets = marketRows.map(
        (row, index): MarketWithId => ({
          ...row.market,
          id: index + 1,
        }),
      );

      if (
        markets.length !==
        archivedNames.length
      ) {
        const found = new Set(
          markets.map(
            (market) => market.name,
          ),
        );

        const missing = archivedNames
          .map((row) => row.name)
          .filter(
            (name) => !found.has(name),
          );

        throw new Error(
          'Archive contains markets missing ' +
          'from markets table: ' +
          missing.join(', '),
        );
      }

      db.exec('BEGIN');

      try {
        for (const market of markets) {
          insertMarket(
            insertMarketStatement,
            market,
          );
        }

        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }

      const totals: ExtractionTotals = {
        processedSnapshots: 0,
        sourceObservations: 0,
        observations: 0,
        duplicates: 0,
        rejected: 0,
      };

      const codecNames = new Set<string>();

      console.log(
        `Building cache for ${markets.length} markets`,
      );

      console.log(
        'Archive snapshot range: ' +
        `${new Date(firstEndedAt).toISOString()} .. ` +
        new Date(lastEndedAt).toISOString(),
      );

      for (
        let marketIndex = 0;
        marketIndex < markets.length;
        marketIndex++
      ) {
        const market = markets[marketIndex];

        const seen = new Set<number>();

        const stats: MarketStats = {
          marketId: market.id,

          snapshotCount: 0,
          sourceObservationCount: 0,
          observationCount: 0,
          duplicateCount: 0,
          rejectedCount: 0,

          firstReceivedAt: null,
          lastReceivedAt: null,

          firstSnapshotEndedAt: null,
          lastSnapshotEndedAt: null,
        };

        const snapshots =
          sql<ArchiveSnapshotRow[]>`
            SELECT
              ended_at AS "endedAt",
              data
            FROM storage_archive
            WHERE market_name = ${market.name}
            ORDER BY
              ended_at DESC,
              started_at DESC
          `.cursor(1);

        for await (const rows of snapshots) {
          const snapshot = rows[0];

          if (!snapshot) {
            continue;
          }

          const snapshotEndedAt = safeInteger(
            snapshot.endedAt,
            `${market.name}.snapshot.endedAt`,
          );

          stats.snapshotCount++;

          stats.firstSnapshotEndedAt =
            stats.firstSnapshotEndedAt === null
              ? snapshotEndedAt
              : Math.min(
                  stats.firstSnapshotEndedAt,
                  snapshotEndedAt,
                );

          stats.lastSnapshotEndedAt =
            stats.lastSnapshotEndedAt === null
              ? snapshotEndedAt
              : Math.max(
                  stats.lastSnapshotEndedAt,
                  snapshotEndedAt,
                );

          const entire =
            decodeEntireBinary(snapshot.data);

          codecNames.add(entire.codecName);

          let observations: MarketTick[];

          if (entire.codecName === 'ticks v1.0') {
            observations = decodeCodec('ticks v1.0', entire.data);
          } else if (entire.codecName === 'snapshot v1.0') {
            const storage = new Storage(market.name);
            storage.applySnapshot({
              codecName: entire.codecName,
              data: entire.data,
            });

            const candles = storage.getAccessors()
              .candles[CANDLE_NAME] as LazyArray<MarketCandle>;
            observations = [];

            for (let index = storage.levelBoundaries[0];
              index < storage.size; index++) {
              const { receivedAt, price } = candles.get(index);
              observations.push({ receivedAt, price });
            }
          } else {
            throw new Error(`Unsupported archive codec: ${entire.codecName}`);
          }

          for (const candle of observations) {

            stats.sourceObservationCount++;

            if (
              !Number.isSafeInteger(
                candle.receivedAt,
              ) ||
              !Number.isFinite(
                candle.price,
              ) ||
              candle.price <= 0
            ) {
              stats.rejectedCount++;
              continue;
            }

            if (
              seen.has(candle.receivedAt)
            ) {
              stats.duplicateCount++;
              continue;
            }

            // Snapshots are read newest-first,
            // so the first valid occurrence wins.
            seen.add(candle.receivedAt);

            writer.write(
              market.id,
              candle.receivedAt,
              candle.price,
            );

            stats.observationCount++;

            stats.firstReceivedAt =
              stats.firstReceivedAt === null
                ? candle.receivedAt
                : Math.min(
                    stats.firstReceivedAt,
                    candle.receivedAt,
                  );

            stats.lastReceivedAt =
              stats.lastReceivedAt === null
                ? candle.receivedAt
                : Math.max(
                    stats.lastReceivedAt,
                    candle.receivedAt,
                  );
          }
        }

        writer.flush();

        insertStatsStatement.run(
          stats.marketId,

          stats.snapshotCount,
          stats.sourceObservationCount,
          stats.observationCount,
          stats.duplicateCount,
          stats.rejectedCount,

          stats.firstReceivedAt,
          stats.lastReceivedAt,

          stats.firstSnapshotEndedAt,
          stats.lastSnapshotEndedAt,
        );

        totals.processedSnapshots +=
          stats.snapshotCount;

        totals.sourceObservations +=
          stats.sourceObservationCount;

        totals.observations +=
          stats.observationCount;

        totals.duplicates +=
          stats.duplicateCount;

        totals.rejected +=
          stats.rejectedCount;

        console.log(
          `[${marketIndex + 1}/${markets.length}] ` +
          `${market.name}: ` +
          `snapshots=${stats.snapshotCount}, ` +
          `observations=${stats.observationCount}, ` +
          `duplicates=${stats.duplicateCount}, ` +
          `rejected=${stats.rejectedCount}`,
        );
      }

      if (
        totals.processedSnapshots !==
        sourceSnapshotCount
      ) {
        throw new Error(
          'Processed snapshot count mismatch: ' +
          `${totals.processedSnapshots} != ` +
          `${sourceSnapshotCount}`,
        );
      }

      writeMetadata(db, {
        schema_version:
          SCHEMA_VERSION,

        created_at_utc:
          new Date().toISOString(),

        source_first_snapshot_ended_at:
          firstEndedAt,

        source_first_snapshot_ended_at_utc:
          new Date(firstEndedAt).toISOString(),

        source_last_snapshot_ended_at:
          lastEndedAt,

        source_last_snapshot_ended_at_utc:
          new Date(lastEndedAt).toISOString(),

        source_snapshot_count:
          sourceSnapshotCount,

        processed_snapshot_count:
          totals.processedSnapshots,

        largest_snapshot_bytes:
          largestSnapshotBytes,

        market_count:
          markets.length,

        source_observation_count:
          totals.sourceObservations,

        observation_count:
          totals.observations,

        duplicate_source_observation_count:
          totals.duplicates,

        rejected_source_observation_count:
          totals.rejected,

        duplicate_policy:
          'newest-snapshot-first; ' +
          'first-valid-received-at-wins',

        source_codec_names:
          JSON.stringify(
            [...codecNames].sort(),
          ),

        extractor_git_commit:
          getGitCommit(),
      });
    });

    writer.flush();

    db.exec('PRAGMA optimize');
    db.close();

    if (finalPath === null) {
      throw new Error(
        'Final cache path was not initialized',
      );
    }

    if (
      OVERWRITE &&
      await pathExists(finalPath)
    ) {
      await rm(
        finalPath,
        { force: true },
      );
    }

    await rename(
      temporaryPath,
      finalPath,
    );

    completed = true;

    console.log('');
    console.log(
      `Cache written: ${finalPath}`,
    );

    console.log(
      `Elapsed: ${(
        (Date.now() - startedAt) /
        1000
      ).toFixed(1)} s`,
    );
  } catch (error) {
    writer.rollback();

    try {
      db.close();
    } catch {
      // Preserve the original error.
    }

    throw error;
  } finally {
    await rm(
      temporaryDirectory,
      {
        recursive: true,
        force: true,
      },
    );

    if (!completed) {
      console.error(
        'Cache build failed; ' +
        'partial output was removed.',
      );
    }
  }
}

await main();
