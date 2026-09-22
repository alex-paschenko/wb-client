import 'dotenv/config';

import { createReadStream } from 'node:fs';
import {
  mkdir,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const INPUT_PATH = resolve(
  process.cwd(),
  'research-output/market-phase/samples.csv',
);

const OUTPUT_DIRECTORY = resolve(
  process.cwd(),
  'research-output/market-phase',
);

const OUTPUT_PATH = resolve(
  OUTPUT_DIRECTORY,
  'normalized-acceleration-summary.csv',
);

const ACCELERATION_BOUNDARIES = [
  -4,
  -2,
  -1,
  -0.5,
  -0.2,
  0,
  0.2,
  0.5,
  1,
  2,
  4,
] as const;

const ACCELERATION_BIN_NAMES = [
  '<-4',
  '-4..-2',
  '-2..-1',
  '-1..-0.5',
  '-0.5..-0.2',
  '-0.2..0',
  '0..0.2',
  '0.2..0.5',
  '0.5..1',
  '1..2',
  '2..4',
  '>=4',
] as const;

interface CsvIndexes {
  market: number;
  horizonMs: number;
  normalizedAcceleration: number;
  speedQuantile: number;
  surpriseQuantile: number;
  alignedReturnPermille: number;
  mfePermille: number;
  maePermille: number;
}

interface Accumulator {
  market: string;
  horizonMs: number;
  speedQuantile: number;
  surpriseQuantile: number;
  normalizedAccelerationBin: string;

  count: number;
  positiveCount: number;

  alignedReturnSum: number;

  mfeSum: number;
  maeSum: number;
}

interface SummaryRow {
  market: string;
  horizonMs: number;
  speedQuantile: number;
  surpriseQuantile: number;
  normalizedAccelerationBin: string;

  count: number;

  meanAlignedReturnPermille: number;
  positiveRate: number;

  meanMfePermille: number;
  meanMaePermille: number;
}

const escapeCsv = (
  value: string | number,
): string => {
  const stringValue = String(value);

  if (!/[",\n\r]/.test(stringValue)) {
    return stringValue;
  }

  return `"${stringValue.replaceAll('"', '""')}"`;
};

const parseHeader = (
  line: string,
): CsvIndexes => {
  const columns = line.split(',');

  const getIndex = (name: string): number => {
    const index = columns.indexOf(name);

    if (index < 0) {
      throw new Error(
        `Column "${name}" not found in samples.csv`,
      );
    }

    return index;
  };

  return {
    market: getIndex('market'),
    horizonMs: getIndex('horizonMs'),

    normalizedAcceleration:
      getIndex('normalizedAcceleration'),

    speedQuantile:
      getIndex('speedQuantile'),

    surpriseQuantile:
      getIndex('surpriseQuantile'),

    alignedReturnPermille:
      getIndex('alignedReturnPermille'),

    mfePermille:
      getIndex('mfePermille'),

    maePermille:
      getIndex('maePermille'),
  };
};

const getAccelerationBinIndex = (
  value: number,
): number => {
  for (
    let index = 0;
    index < ACCELERATION_BOUNDARIES.length;
    index++
  ) {
    if (
      value <
      ACCELERATION_BOUNDARIES[index]
    ) {
      return index;
    }
  }

  return ACCELERATION_BOUNDARIES.length;
};

const addSample = (
  accumulators: Map<string, Accumulator>,
  market: string,
  horizonMs: number,
  speedQuantile: number,
  surpriseQuantile: number,
  normalizedAcceleration: number,
  alignedReturnPermille: number,
  mfePermille: number,
  maePermille: number,
): void => {
  const accelerationBinIndex =
    getAccelerationBinIndex(
      normalizedAcceleration,
    );

  const normalizedAccelerationBin =
    ACCELERATION_BIN_NAMES[
      accelerationBinIndex
    ];

  const key = [
    market,
    horizonMs,
    speedQuantile,
    surpriseQuantile,
    accelerationBinIndex,
  ].join('|');

  let accumulator =
    accumulators.get(key);

  if (!accumulator) {
    accumulator = {
      market,
      horizonMs,
      speedQuantile,
      surpriseQuantile,
      normalizedAccelerationBin,

      count: 0,
      positiveCount: 0,

      alignedReturnSum: 0,

      mfeSum: 0,
      maeSum: 0,
    };

    accumulators.set(
      key,
      accumulator,
    );
  }

  accumulator.count += 1;

  accumulator.positiveCount +=
    Number(alignedReturnPermille > 0);

  accumulator.alignedReturnSum +=
    alignedReturnPermille;

  accumulator.mfeSum +=
    mfePermille;

  accumulator.maeSum +=
    maePermille;
};

const getSummaryRows = (
  accumulators:
    ReadonlyMap<string, Accumulator>,
): SummaryRow[] => {
  return [
    ...accumulators.values(),
  ].map((accumulator) => ({
    market: accumulator.market,

    horizonMs:
      accumulator.horizonMs,

    speedQuantile:
      accumulator.speedQuantile,

    surpriseQuantile:
      accumulator.surpriseQuantile,

    normalizedAccelerationBin:
      accumulator.normalizedAccelerationBin,

    count:
      accumulator.count,

    meanAlignedReturnPermille:
      accumulator.alignedReturnSum /
      accumulator.count,

    positiveRate:
      accumulator.positiveCount /
      accumulator.count,

    meanMfePermille:
      accumulator.mfeSum /
      accumulator.count,

    meanMaePermille:
      accumulator.maeSum /
      accumulator.count,
  }));
};

const writeSummary = async (
  summary: readonly SummaryRow[],
): Promise<void> => {
  const headers = [
    'market',
    'horizonMs',
    'speedQuantile',
    'surpriseQuantile',
    'normalizedAccelerationBin',
    'count',
    'meanAlignedReturnPermille',
    'positiveRate',
    'meanMfePermille',
    'meanMaePermille',
  ];

  const rows = summary.map(
    (row) => [
      row.market,
      row.horizonMs,
      row.speedQuantile,
      row.surpriseQuantile,
      row.normalizedAccelerationBin,
      row.count,
      row.meanAlignedReturnPermille,
      row.positiveRate,
      row.meanMfePermille,
      row.meanMaePermille,
    ],
  );

  const csv = [
    headers.map(escapeCsv).join(','),
    ...rows.map(
      (row) =>
        row.map(escapeCsv).join(','),
    ),
  ].join('\n') + '\n';

  await writeFile(
    OUTPUT_PATH,
    csv,
    'utf8',
  );
};

const main = async (): Promise<void> => {
  await mkdir(
    OUTPUT_DIRECTORY,
    { recursive: true },
  );

  const input =
    createReadStream(
      INPUT_PATH,
      {
        encoding: 'utf8',
      },
    );

  const lines =
    createInterface({
      input,
      crlfDelay: Infinity,
    });

  const accumulators =
    new Map<string, Accumulator>();

  let indexes:
    CsvIndexes | undefined;

  let processedRows = 0;
  let skippedRows = 0;

  const startedAt = Date.now();

  for await (const line of lines) {
    if (!indexes) {
      indexes = parseHeader(line);
      continue;
    }

    if (!line) {
      continue;
    }

    /*
     * samples.csv contains only numeric/string fields without commas,
     * so a simple split is sufficient for this generated file.
     */
    const columns = line.split(',');

    const market =
      columns[indexes.market];

    const horizonMs =
      Number(
        columns[indexes.horizonMs],
      );

    const normalizedAcceleration =
      Number(
        columns[
          indexes.normalizedAcceleration
        ],
      );

    const speedQuantile =
      Number(
        columns[
          indexes.speedQuantile
        ],
      );

    const surpriseQuantile =
      Number(
        columns[
          indexes.surpriseQuantile
        ],
      );

    const alignedReturnPermille =
      Number(
        columns[
          indexes.alignedReturnPermille
        ],
      );

    const mfePermille =
      Number(
        columns[indexes.mfePermille],
      );

    const maePermille =
      Number(
        columns[indexes.maePermille],
      );

    if (
      !market ||
      !Number.isFinite(horizonMs) ||
      !Number.isFinite(
        normalizedAcceleration,
      ) ||
      !Number.isFinite(
        speedQuantile,
      ) ||
      !Number.isFinite(
        surpriseQuantile,
      ) ||
      !Number.isFinite(
        alignedReturnPermille,
      ) ||
      !Number.isFinite(mfePermille) ||
      !Number.isFinite(maePermille)
    ) {
      skippedRows += 1;
      continue;
    }

    addSample(
      accumulators,
      market,
      horizonMs,
      speedQuantile,
      surpriseQuantile,
      normalizedAcceleration,
      alignedReturnPermille,
      mfePermille,
      maePermille,
    );

    /*
     * Add the same observation to the pooled bucket.
     */
    addSample(
      accumulators,
      '*',
      horizonMs,
      speedQuantile,
      surpriseQuantile,
      normalizedAcceleration,
      alignedReturnPermille,
      mfePermille,
      maePermille,
    );

    processedRows += 1;

    if (
      processedRows % 1_000_000 === 0
    ) {
      const elapsedSeconds =
        (Date.now() - startedAt) /
        1000;

      const rowsPerSecond =
        processedRows /
        elapsedSeconds;

      console.log(
        `${processedRows.toLocaleString()} rows, ` +
        `${Math.round(
          rowsPerSecond,
        ).toLocaleString()} rows/s`,
      );
    }
  }

  if (!indexes) {
    throw new Error(
      'samples.csv is empty',
    );
  }

  const summary =
    getSummaryRows(
      accumulators,
    );

  await writeSummary(summary);

  const elapsedSeconds =
    (Date.now() - startedAt) /
    1000;

  console.log(
    `Done. ` +
    `${processedRows.toLocaleString()} rows processed, ` +
    `${skippedRows.toLocaleString()} skipped.`,
  );

  console.log(
    `${summary.length.toLocaleString()} summary rows.`,
  );

  console.log(
    `Elapsed: ${elapsedSeconds.toFixed(1)} s.`,
  );

  console.log(
    `Output: ${OUTPUT_PATH}`,
  );
};

await main();
