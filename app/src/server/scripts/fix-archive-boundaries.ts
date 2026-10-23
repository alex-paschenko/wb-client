// app/src/server/scripts/fix-archive-boundaries.ts
// Dry run: node --import tsx src/server/scripts/fix-archive-boundaries.ts
// Apply:   node --import tsx src/server/scripts/fix-archive-boundaries.ts --apply
// Filter:  add --market POL_PERP
// Changing ended_at requires --allow-ended-at (and stopped archiving).

import 'dotenv/config';

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encodeEntireBinary } from '../../shared/utilities/codecs/entire-binary-codec.js';
import { q } from '../db/client.js';

const PAGE_SIZE = 250;
const UPDATE_BATCH_SIZE = 100;
const OUTPUT_DIR = resolve('research-output/archive-boundary-fix');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const allowEndedAt = args.includes('--allow-ended-at');
const marketIndex = args.indexOf('--market');
const marketName = marketIndex < 0 ? null : args[marketIndex + 1];

if (marketIndex >= 0 && (!marketName || marketName.startsWith('--'))) {
  throw new Error('Expected market name after --market');
}

interface RawRow {
  marketName: string;
  startedAt: string | number;
  endedAt: string | number;
  numOfItems: number;
  byteLength: number;
  header: Uint8Array;
  firstBytes: Uint8Array;
  lastBytes: Uint8Array;
}

const headerCache = new Map<string, Uint8Array>();

interface Change {
  marketName: string;
  oldStartedAt: number;
  oldEndedAt: number;
  startedAt: number;
  endedAt: number;
  numOfItems: number;
}

function asBuffer(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function checkRow(row: RawRow): Change {
  const count = Number(row.numOfItems);
  const oldStartedAt = Number(row.startedAt);
  const oldEndedAt = Number(row.endedAt);
  const label = `${row.marketName}/${oldEndedAt}`;

  if (!Number.isSafeInteger(count) || count <= 0 ||
      !Number.isSafeInteger(oldStartedAt) ||
      !Number.isSafeInteger(oldEndedAt)) {
    throw new Error(`Invalid SQL metadata: ${label}`);
  }

  // An empty ticks v1.0 archive gives us the exact, market-specific
  // header layout. Its final 8 bytes are payload size and tick count.
  let empty = headerCache.get(row.marketName);
  if (!empty) {
    empty = encodeEntireBinary({
      codecName: 'ticks v1.0',
      binaryKind: 'snapshot',
      parameters: { marketName: row.marketName },
      data: [],
    });
    headerCache.set(row.marketName, empty);
  }
  const prefixSize = empty.byteLength - 8;
  const expectedPrefix = asBuffer(empty.subarray(0, prefixSize));
  const header = asBuffer(row.header);

  if (row.byteLength !== empty.byteLength + count * 16 ||
      header.length !== empty.byteLength ||
      !header.subarray(0, prefixSize).equals(expectedPrefix) ||
      header.readUInt32LE(prefixSize) !== 4 + count * 16 ||
      header.readUInt32LE(prefixSize + 4) !== count) {
    throw new Error(`Invalid codec, size or count: ${label}`);
  }

  const first = asBuffer(row.firstBytes);
  const last = asBuffer(row.lastBytes);
  if (first.length !== 8 || last.length !== 8) {
    throw new Error(`Missing first/last tick: ${label}`);
  }

  const startedAt = first.readDoubleLE(0);
  const endedAt = last.readDoubleLE(0);
  if (!Number.isSafeInteger(startedAt) ||
      !Number.isSafeInteger(endedAt) || startedAt > endedAt) {
    throw new Error(`Invalid tick boundaries: ${label}`);
  }
  if (startedAt < oldStartedAt || endedAt > oldEndedAt) {
    throw new Error(
      `Ticks extend outside declared archive range: ${label}; ` +
      `${oldStartedAt}..${oldEndedAt} vs ${startedAt}..${endedAt}`,
    );
  }

  return {
    marketName: row.marketName,
    oldStartedAt, oldEndedAt,
    startedAt, endedAt, numOfItems: count,
  };
}

async function scan(): Promise<{
  changes: Change[];
  scanned: number;
  changedEnds: number;
}> {
  const changes: Change[] = [];
  let scanned = 0;
  let changedEnds = 0;
  let cursor: { marketName: string; endedAt: number } | null = null;
  let previous: Change | null = null;
  let lastLog = Date.now();

  for (;;) {
    // ticks v1.0 uses 16 bytes per tick. PostgreSQL returns only the
    // short header and two timestamps, never the complete tick arrays.
    const rows = await q<RawRow[]>`
      select
        market_name as "marketName",
        started_at as "startedAt",
        ended_at as "endedAt",
        num_of_items as "numOfItems",
        octet_length(data) as "byteLength",
        substring(data from 1 for
          47 + octet_length(convert_to(market_name, 'UTF8'))
        ) as header,
        substring(data from
          48 + octet_length(convert_to(market_name, 'UTF8'))
          for 8
        ) as "firstBytes",
        substring(data from
          48 + octet_length(convert_to(market_name, 'UTF8')) +
          (num_of_items - 1) * 16 for 8
        ) as "lastBytes"
      from storage_archive
      where ${marketName === null ? q`true` :
        q`market_name = ${marketName}`}
        ${cursor === null ? q`` : q`
          and (market_name, ended_at) >
              (${cursor.marketName}, ${cursor.endedAt})
        `}
      order by market_name, ended_at
      limit ${PAGE_SIZE}
    `;

    if (rows.length === 0) break;

    for (const row of rows) {
      const item = checkRow(row);

      if (previous?.marketName === item.marketName &&
          item.startedAt <= previous.endedAt) {
        throw new Error(
          `Overlapping actual tick ranges: ` +
          `${item.marketName}/${previous.oldEndedAt} and ` +
          `${item.marketName}/${item.oldEndedAt}`,
        );
      }

      previous = item;
      scanned++;
      if (item.startedAt !== item.oldStartedAt ||
          item.endedAt !== item.oldEndedAt) {
        changes.push(item);
        changedEnds += Number(item.endedAt !== item.oldEndedAt);
        if (changes.length <= 20) {
          console.log('[mismatch]', item);
        }
      }
    }

    const last = rows[rows.length - 1];
    cursor = {
      marketName: last.marketName,
      endedAt: Number(last.endedAt),
    };

    if (Date.now() - lastLog >= 10_000) {
      console.log('[scan]', {
        scanned, mismatches: changes.length,
        through: `${cursor.marketName}/${cursor.endedAt}`,
      });
      lastLog = Date.now();
    }
  }

  return { changes, scanned, changedEnds };
}

async function main(): Promise<void> {
  console.log('[start]', { apply, marketName, allowEndedAt });
  console.log('[scan] Checking archive boundaries without modifications...');
  const result = await scan();

  await mkdir(OUTPUT_DIR, { recursive: true });
  const output = await mkdtemp(resolve(OUTPUT_DIR, 'run-'));
  const report = resolve(output, 'changes.json');
  await writeFile(report, JSON.stringify({
    createdAt: new Date().toISOString(),
    marketName, scanned: result.scanned,
    mismatches: result.changes.length,
    changedEnds: result.changedEnds,
    changes: result.changes,
  }, null, 2) + '\n');

  console.log('[scan complete]', {
    scanned: result.scanned,
    mismatches: result.changes.length,
    changedEnds: result.changedEnds,
    report,
  });

  if (!apply) {
    console.log('[dry-run] Nothing changed. Add --apply to update.');
    return;
  }

  if (result.changedEnds > 0 && !allowEndedAt) {
    throw new Error(
      `${result.changedEnds} rows require ended_at changes. ` +
      `This is the archive primary key and cursor. ` +
      `Review changes.json and rerun with --allow-ended-at ` +
      `only while archiving and repacking are stopped.`,
    );
  }

  let updated = 0;
  for (let index = 0; index < result.changes.length;
    index += UPDATE_BATCH_SIZE) {
    const batch = result.changes.slice(index, index + UPDATE_BATCH_SIZE);

    await q.begin(async (tx) => {
      for (const change of batch) {
        const updatedRows = await tx<{ marketName: string }[]>`
          update storage_archive
          set started_at = ${change.startedAt},
              ended_at = ${change.endedAt},
              updated_at = now()
          where market_name = ${change.marketName}
            and started_at = ${change.oldStartedAt}
            and ended_at = ${change.oldEndedAt}
            and num_of_items = ${change.numOfItems}
          returning market_name as "marketName"
        `;

        if (updatedRows.length !== 1) {
          throw new Error(
            `Archive row changed during repair: ` +
            `${change.marketName}/${change.oldEndedAt}`,
          );
        }
      }
    });

    updated += batch.length;
    console.log('[apply]', `${updated}/${result.changes.length}`);
  }

  console.log('[done]', { updated, report });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await q.end();
});
