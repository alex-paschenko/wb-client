// app/src/server/research/market-phase-online-oos-analysis.ts

import 'dotenv/config';

import {
  createReadStream,
  createWriteStream,
} from 'node:fs';
import type {
  WriteStream,
} from 'node:fs';
import {
  mkdir,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const SOURCE_RUN_ID = 'online-30s-d10s';
const TRAIN_FRACTION = 0.7;

const OUTPUT_DIRECTORY = resolve(
  process.cwd(),
  'research-output/market-phase',
);

const SOURCE_PATH = resolve(
  OUTPUT_DIRECTORY,
  `samples-${SOURCE_RUN_ID}.csv`,
);

const RUN_ID = [
  SOURCE_RUN_ID,
  `s${Math.round(TRAIN_FRACTION * 100)}`,
].join('-');

const SUMMARY_PATH = resolve(
  OUTPUT_DIRECTORY,
  `oos-summary-${RUN_ID}.csv`,
);

const CROSS_MARKET_PATH = resolve(
  OUTPUT_DIRECTORY,
  `oos-cross-market-${RUN_ID}.csv`,
);

const SPLITS_PATH = resolve(
  OUTPUT_DIRECTORY,
  `oos-splits-${RUN_ID}.csv`,
);

const METADATA_PATH = resolve(
  OUTPUT_DIRECTORY,
  `oos-metadata-${RUN_ID}.json`,
);

const NORMALIZED_SPEED_BOUNDARIES = [
  0.1,
  0.2,
  0.3,
  0.5,
  0.75,
  1,
  1.5,
  2,
  3,
  5,
  8,
] as const;

const RELATIVE_ACCELERATION_BOUNDARIES = [
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

const ALIGNED_SURPRISE_BOUNDARIES = [
  -5,
  -3,
  -2,
  -1.5,
  -1,
  -0.75,
  -0.5,
  -0.25,
  0,
  0.25,
  0.5,
  0.75,
  1,
  1.5,
  2,
  3,
  5,
] as const;

type Split = 'train' | 'test';

interface SourceColumns {
  market: number;
  receivedAt: number;
  horizonMs: number;

  absoluteNormalizedSpeed: number;
  relativeAcceleration: number;
  alignedSurprise: number;

  alignedReturnPermille: number;

  mfePermille: number;
  mfeAtMs: number;

  maePermille: number;
  maeAtMs: number;
}

interface MarketTimeRange {
  minReceivedAt: number;
  maxReceivedAt: number;
  splitAt: number;
}

interface StatisticsAccumulator {
  count: number;
  positiveCount: number;

  alignedReturnSum: number;
  alignedReturnSquaredSum: number;

  mfeSum: number;
  mfeAtSum: number;

  maeSum: number;
  maeAtSum: number;
}

interface MarketAccumulator
extends StatisticsAccumulator {
  split: Split;
  market: string;
  horizonMs: number;

  normalizedSpeedBinIndex: number;
  relativeAccelerationBinIndex: number;
  alignedSurpriseBinIndex: number;
}

interface MarketSummaryRow {
  split: Split;
  market: string;
  horizonMs: number;

  normalizedSpeedBin: string;
  relativeAccelerationBin: string;
  alignedSurpriseBin: string;

  count: number;

  meanAlignedReturnPermille: number;
  stdDevAlignedReturnPermille: number;
  positiveRate: number;

  meanMfePermille: number;
  meanMfeAtMs: number;

  meanMaePermille: number;
  meanMaeAtMs: number;
}

interface CrossMarketAccumulator {
  split: Split;
  horizonMs: number;

  normalizedSpeedBinIndex: number;
  relativeAccelerationBinIndex: number;
  alignedSurpriseBinIndex: number;

  markets: number;
  samples: number;

  weightedReturnSum: number;

  marketReturnSum: number;
  marketMeanReturns: number[];

  marketPositiveCount: number;
  marketPositiveRates: number[];
}

interface CrossMarketRow {
  split: Split;
  horizonMs: number;

  normalizedSpeedBin: string;
  relativeAccelerationBin: string;
  alignedSurpriseBin: string;

  markets: number;
  samples: number;

  weightedMeanAlignedReturnPermille: number;
  marketMeanAlignedReturnPermille: number;
  marketMedianAlignedReturnPermille: number;

  positiveMarketRate: number;
  medianPositiveRate: number;
}

const SUMMARY_HEADERS = [
  'split',
  'market',
  'horizonMs',
  'normalizedSpeedBin',
  'relativeAccelerationBin',
  'alignedSurpriseBin',
  'count',
  'meanAlignedReturnPermille',
  'stdDevAlignedReturnPermille',
  'positiveRate',
  'meanMfePermille',
  'meanMfeAtMs',
  'meanMaePermille',
  'meanMaeAtMs',
] as const;

const CROSS_MARKET_HEADERS = [
  'split',
  'horizonMs',
  'normalizedSpeedBin',
  'relativeAccelerationBin',
  'alignedSurpriseBin',
  'markets',
  'samples',
  'weightedMeanAlignedReturnPermille',
  'marketMeanAlignedReturnPermille',
  'marketMedianAlignedReturnPermille',
  'positiveMarketRate',
  'medianPositiveRate',
] as const;

const SPLIT_HEADERS = [
  'market',
  'minReceivedAt',
  'maxReceivedAt',
  'splitAt',
  'durationMs',
  'trainDurationMs',
  'testDurationMs',
] as const;

const escapeCsv = (
  value: string | number,
): string => {
  const stringValue = String(value);

  if (!/[",\n\r]/.test(stringValue)) {
    return stringValue;
  }

  return `"${stringValue.replaceAll(
    '"',
    '""',
  )}"`;
};

const getCsvLine = (
  values: readonly (string | number)[],
): string =>
  values.map(escapeCsv).join(',') + '\n';

const parseCsvLine = (
  line: string,
): string[] => {
  const values: string[] = [];

  let value = '';
  let quoted = false;

  for (
    let index = 0;
    index < line.length;
    index++
  ) {
    const character = line[index];

    if (quoted) {
      if (character === '"') {
        if (
          index + 1 < line.length &&
          line[index + 1] === '"'
        ) {
          value += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        value += character;
      }

      continue;
    }

    if (character === '"') {
      quoted = true;
      continue;
    }

    if (character === ',') {
      values.push(value);
      value = '';
      continue;
    }

    value += character;
  }

  values.push(value);

  return values;
};

const getSourceColumns = (
  headerLine: string,
): SourceColumns => {
  const headers =
    parseCsvLine(headerLine);

  const getColumn = (
    name: string,
  ): number => {
    const index =
      headers.indexOf(name);

    if (index < 0) {
      throw new Error(
        `Source column not found: ${name}`,
      );
    }

    return index;
  };

  return {
    market:
      getColumn('market'),

    receivedAt:
      getColumn('receivedAt'),

    horizonMs:
      getColumn('horizonMs'),

    absoluteNormalizedSpeed:
      getColumn(
        'absoluteNormalizedSpeed',
      ),

    relativeAcceleration:
      getColumn(
        'relativeAcceleration',
      ),

    alignedSurprise:
      getColumn('alignedSurprise'),

    alignedReturnPermille:
      getColumn(
        'alignedReturnPermille',
      ),

    mfePermille:
      getColumn('mfePermille'),

    mfeAtMs:
      getColumn('mfeAtMs'),

    maePermille:
      getColumn('maePermille'),

    maeAtMs:
      getColumn('maeAtMs'),
  };
};

const getBinIndex = (
  value: number,
  boundaries: readonly number[],
): number => {
  for (
    let index = 0;
    index < boundaries.length;
    index++
  ) {
    if (value < boundaries[index]) {
      return index;
    }
  }

  return boundaries.length;
};

const getBinName = (
  boundaries: readonly number[],
  index: number,
): string => {
  if (index === 0) {
    return `<${boundaries[0]}`;
  }

  if (index === boundaries.length) {
    return `>=${boundaries[index - 1]}`;
  }

  return (
    `${boundaries[index - 1]}..` +
    `${boundaries[index]}`
  );
};

const createStatisticsAccumulator =
  (): StatisticsAccumulator => ({
    count: 0,
    positiveCount: 0,

    alignedReturnSum: 0,
    alignedReturnSquaredSum: 0,

    mfeSum: 0,
    mfeAtSum: 0,

    maeSum: 0,
    maeAtSum: 0,
  });

const addStatistics = (
  accumulator: StatisticsAccumulator,
  alignedReturnPermille: number,
  mfePermille: number,
  mfeAtMs: number,
  maePermille: number,
  maeAtMs: number,
): void => {
  accumulator.count++;

  accumulator.positiveCount +=
    Number(alignedReturnPermille > 0);

  accumulator.alignedReturnSum +=
    alignedReturnPermille;

  accumulator.alignedReturnSquaredSum +=
    alignedReturnPermille *
    alignedReturnPermille;

  accumulator.mfeSum +=
    mfePermille;

  accumulator.mfeAtSum +=
    mfeAtMs;

  accumulator.maeSum +=
    maePermille;

  accumulator.maeAtSum +=
    maeAtMs;
};

const getStandardDeviation = (
  accumulator: StatisticsAccumulator,
): number => {
  if (accumulator.count < 2) {
    return 0;
  }

  const variance =
    (
      accumulator.alignedReturnSquaredSum -
      accumulator.alignedReturnSum *
      accumulator.alignedReturnSum /
      accumulator.count
    ) /
    (accumulator.count - 1);

  return Math.sqrt(
    Math.max(0, variance),
  );
};

const getMedian = (
  values: number[],
): number => {
  if (values.length === 0) {
    return Number.NaN;
  }

  values.sort(
    (a, b) => a - b,
  );

  const middle =
    Math.floor(values.length / 2);

  if (values.length % 2 === 1) {
    return values[middle];
  }

  return (
    values[middle - 1] +
    values[middle]
  ) / 2;
};

const toFiniteString = (
  value: number,
): string =>
  Number.isFinite(value)
    ? String(value)
    : '';

const writeToStream = async (
  stream: WriteStream,
  data: string,
): Promise<void> => {
  if (stream.write(data)) {
    return;
  }

  await new Promise<void>(
    (resolvePromise, reject) => {
      const onDrain = (): void => {
        cleanup();
        resolvePromise();
      };

      const onError = (
        error: Error,
      ): void => {
        cleanup();
        reject(error);
      };

      const cleanup = (): void => {
        stream.off('drain', onDrain);
        stream.off('error', onError);
      };

      stream.once('drain', onDrain);
      stream.once('error', onError);
    },
  );
};

const closeStream = async (
  stream: WriteStream,
): Promise<void> => {
  await new Promise<void>(
    (resolvePromise, reject) => {
      stream.once(
        'finish',
        resolvePromise,
      );

      stream.once(
        'error',
        reject,
      );

      stream.end();
    },
  );
};

const createSourceReader = () => {
  return createInterface({
    input: createReadStream(
      SOURCE_PATH,
      {
        encoding: 'utf8',
      },
    ),
    crlfDelay: Infinity,
  });
};

const scanMarketTimeRanges = async ():
Promise<{
  ranges: Map<string, MarketTimeRange>;
  sourceRows: number;
}> => {
  const ranges =
    new Map<string, MarketTimeRange>();

  const reader =
    createSourceReader();

  let columns: SourceColumns | null =
    null;

  let sourceRows = 0;

  for await (const line of reader) {
    if (columns === null) {
      columns =
        getSourceColumns(line);

      continue;
    }

    if (line.length === 0) {
      continue;
    }

    const values =
      parseCsvLine(line);

    const market =
      values[columns.market];

    const receivedAt =
      Number(
        values[columns.receivedAt],
      );

    if (
      !market ||
      !Number.isFinite(receivedAt)
    ) {
      continue;
    }

    sourceRows++;

    const existing =
      ranges.get(market);

    if (!existing) {
      ranges.set(
        market,
        {
          minReceivedAt:
            receivedAt,

          maxReceivedAt:
            receivedAt,

          splitAt:
            0,
        },
      );

      continue;
    }

    existing.minReceivedAt =
      Math.min(
        existing.minReceivedAt,
        receivedAt,
      );

    existing.maxReceivedAt =
      Math.max(
        existing.maxReceivedAt,
        receivedAt,
      );
  }

  for (const range of ranges.values()) {
    range.splitAt =
      range.minReceivedAt +
      (
        range.maxReceivedAt -
        range.minReceivedAt
      ) *
      TRAIN_FRACTION;
  }

  return {
    ranges,
    sourceRows,
  };
};

const writeSplitRanges = async (
  ranges:
    ReadonlyMap<
      string,
      MarketTimeRange
    >,
): Promise<void> => {
  const stream =
    createWriteStream(
      SPLITS_PATH,
      { encoding: 'utf8' },
    );

  try {
    await writeToStream(
      stream,
      getCsvLine(SPLIT_HEADERS),
    );

    const markets =
      [...ranges.keys()].sort();

    for (const market of markets) {
      const range =
        ranges.get(market);

      if (!range) {
        continue;
      }

      const duration =
        range.maxReceivedAt -
        range.minReceivedAt;

      await writeToStream(
        stream,
        getCsvLine([
          market,
          range.minReceivedAt,
          range.maxReceivedAt,
          range.splitAt,
          duration,
          range.splitAt -
            range.minReceivedAt,
          range.maxReceivedAt -
            range.splitAt,
        ]),
      );
    }
  } finally {
    await closeStream(stream);
  }
};

const getMarketAccumulatorKey = (
  split: Split,
  horizonMs: number,
  normalizedSpeedBinIndex: number,
  relativeAccelerationBinIndex: number,
  alignedSurpriseBinIndex: number,
): string => {
  return [
    split,
    horizonMs,
    normalizedSpeedBinIndex,
    relativeAccelerationBinIndex,
    alignedSurpriseBinIndex,
  ].join('|');
};

const addMarketSample = (
  accumulators:
    Map<string, MarketAccumulator>,
  split: Split,
  market: string,
  horizonMs: number,
  absoluteNormalizedSpeed: number,
  relativeAcceleration: number,
  alignedSurprise: number,
  alignedReturnPermille: number,
  mfePermille: number,
  mfeAtMs: number,
  maePermille: number,
  maeAtMs: number,
): void => {
  const normalizedSpeedBinIndex =
    getBinIndex(
      absoluteNormalizedSpeed,
      NORMALIZED_SPEED_BOUNDARIES,
    );

  const relativeAccelerationBinIndex =
    getBinIndex(
      relativeAcceleration,
      RELATIVE_ACCELERATION_BOUNDARIES,
    );

  const alignedSurpriseBinIndex =
    getBinIndex(
      alignedSurprise,
      ALIGNED_SURPRISE_BOUNDARIES,
    );

  const key =
    getMarketAccumulatorKey(
      split,
      horizonMs,
      normalizedSpeedBinIndex,
      relativeAccelerationBinIndex,
      alignedSurpriseBinIndex,
    );

  let accumulator =
    accumulators.get(key);

  if (!accumulator) {
    accumulator = {
      ...createStatisticsAccumulator(),

      split,
      market,
      horizonMs,

      normalizedSpeedBinIndex,
      relativeAccelerationBinIndex,
      alignedSurpriseBinIndex,
    };

    accumulators.set(
      key,
      accumulator,
    );
  }

  addStatistics(
    accumulator,
    alignedReturnPermille,
    mfePermille,
    mfeAtMs,
    maePermille,
    maeAtMs,
  );
};

const marketAccumulatorToRow = (
  accumulator: MarketAccumulator,
): MarketSummaryRow => {
  return {
    split:
      accumulator.split,

    market:
      accumulator.market,

    horizonMs:
      accumulator.horizonMs,

    normalizedSpeedBin:
      getBinName(
        NORMALIZED_SPEED_BOUNDARIES,
        accumulator
          .normalizedSpeedBinIndex,
      ),

    relativeAccelerationBin:
      getBinName(
        RELATIVE_ACCELERATION_BOUNDARIES,
        accumulator
          .relativeAccelerationBinIndex,
      ),

    alignedSurpriseBin:
      getBinName(
        ALIGNED_SURPRISE_BOUNDARIES,
        accumulator
          .alignedSurpriseBinIndex,
      ),

    count:
      accumulator.count,

    meanAlignedReturnPermille:
      accumulator.alignedReturnSum /
      accumulator.count,

    stdDevAlignedReturnPermille:
      getStandardDeviation(
        accumulator,
      ),

    positiveRate:
      accumulator.positiveCount /
      accumulator.count,

    meanMfePermille:
      accumulator.mfeSum /
      accumulator.count,

    meanMfeAtMs:
      accumulator.mfeAtSum /
      accumulator.count,

    meanMaePermille:
      accumulator.maeSum /
      accumulator.count,

    meanMaeAtMs:
      accumulator.maeAtSum /
      accumulator.count,
  };
};

const getMarketSummaryCsvLine = (
  row: MarketSummaryRow,
): string => {
  return getCsvLine([
    row.split,
    row.market,
    row.horizonMs,
    row.normalizedSpeedBin,
    row.relativeAccelerationBin,
    row.alignedSurpriseBin,
    row.count,

    toFiniteString(
      row.meanAlignedReturnPermille,
    ),

    toFiniteString(
      row.stdDevAlignedReturnPermille,
    ),

    toFiniteString(
      row.positiveRate,
    ),

    toFiniteString(
      row.meanMfePermille,
    ),

    toFiniteString(
      row.meanMfeAtMs,
    ),

    toFiniteString(
      row.meanMaePermille,
    ),

    toFiniteString(
      row.meanMaeAtMs,
    ),
  ]);
};

const getCrossMarketKey = (
  row: MarketSummaryRow,
): string => {
  return [
    row.split,
    row.horizonMs,
    row.normalizedSpeedBin,
    row.relativeAccelerationBin,
    row.alignedSurpriseBin,
  ].join('|');
};

const addCrossMarketRow = (
  accumulators:
    Map<
      string,
      CrossMarketAccumulator
    >,
  row: MarketSummaryRow,
  source: MarketAccumulator,
): void => {
  const key =
    getCrossMarketKey(row);

  let accumulator =
    accumulators.get(key);

  if (!accumulator) {
    accumulator = {
      split:
        source.split,

      horizonMs:
        source.horizonMs,

      normalizedSpeedBinIndex:
        source.normalizedSpeedBinIndex,

      relativeAccelerationBinIndex:
        source.relativeAccelerationBinIndex,

      alignedSurpriseBinIndex:
        source.alignedSurpriseBinIndex,

      markets: 0,
      samples: 0,

      weightedReturnSum: 0,

      marketReturnSum: 0,
      marketMeanReturns: [],

      marketPositiveCount: 0,
      marketPositiveRates: [],
    };

    accumulators.set(
      key,
      accumulator,
    );
  }

  accumulator.markets++;
  accumulator.samples +=
    source.count;

  accumulator.weightedReturnSum +=
    source.alignedReturnSum;

  accumulator.marketReturnSum +=
    row.meanAlignedReturnPermille;

  accumulator.marketMeanReturns.push(
    row.meanAlignedReturnPermille,
  );

  accumulator.marketPositiveCount +=
    Number(
      row.meanAlignedReturnPermille > 0,
    );

  accumulator.marketPositiveRates.push(
    row.positiveRate,
  );
};

const crossMarketAccumulatorToRow = (
  accumulator:
    CrossMarketAccumulator,
): CrossMarketRow => {
  return {
    split:
      accumulator.split,

    horizonMs:
      accumulator.horizonMs,

    normalizedSpeedBin:
      getBinName(
        NORMALIZED_SPEED_BOUNDARIES,
        accumulator
          .normalizedSpeedBinIndex,
      ),

    relativeAccelerationBin:
      getBinName(
        RELATIVE_ACCELERATION_BOUNDARIES,
        accumulator
          .relativeAccelerationBinIndex,
      ),

    alignedSurpriseBin:
      getBinName(
        ALIGNED_SURPRISE_BOUNDARIES,
        accumulator
          .alignedSurpriseBinIndex,
      ),

    markets:
      accumulator.markets,

    samples:
      accumulator.samples,

    weightedMeanAlignedReturnPermille:
      accumulator.weightedReturnSum /
      accumulator.samples,

    marketMeanAlignedReturnPermille:
      accumulator.marketReturnSum /
      accumulator.markets,

    marketMedianAlignedReturnPermille:
      getMedian(
        accumulator.marketMeanReturns,
      ),

    positiveMarketRate:
      accumulator.marketPositiveCount /
      accumulator.markets,

    medianPositiveRate:
      getMedian(
        accumulator.marketPositiveRates,
      ),
  };
};

const getCrossMarketCsvLine = (
  row: CrossMarketRow,
): string => {
  return getCsvLine([
    row.split,
    row.horizonMs,
    row.normalizedSpeedBin,
    row.relativeAccelerationBin,
    row.alignedSurpriseBin,
    row.markets,
    row.samples,

    toFiniteString(
      row.weightedMeanAlignedReturnPermille,
    ),

    toFiniteString(
      row.marketMeanAlignedReturnPermille,
    ),

    toFiniteString(
      row.marketMedianAlignedReturnPermille,
    ),

    toFiniteString(
      row.positiveMarketRate,
    ),

    toFiniteString(
      row.medianPositiveRate,
    ),
  ]);
};

const aggregateSamples = async (
  ranges:
    ReadonlyMap<
      string,
      MarketTimeRange
    >,
): Promise<{
  usedTrainSamples: number;
  usedTestSamples: number;
  purgedSamples: number;
  marketSummaryRows: number;
  crossMarketRows: number;
}> => {
  const summaryStream =
    createWriteStream(
      SUMMARY_PATH,
      { encoding: 'utf8' },
    );

  const crossMarketAccumulators =
    new Map<
      string,
      CrossMarketAccumulator
    >();

  const reader =
    createSourceReader();

  let columns: SourceColumns | null =
    null;

  let currentMarket: string | null =
    null;

  let marketAccumulators =
    new Map<
      string,
      MarketAccumulator
    >();

  let usedTrainSamples = 0;
  let usedTestSamples = 0;
  let purgedSamples = 0;
  let marketSummaryRows = 0;

  const flushMarket =
    async (): Promise<void> => {
      if (currentMarket === null) {
        return;
      }

      for (
        const accumulator
        of marketAccumulators.values()
      ) {
        const row =
          marketAccumulatorToRow(
            accumulator,
          );

        await writeToStream(
          summaryStream,
          getMarketSummaryCsvLine(
            row,
          ),
        );

        addCrossMarketRow(
          crossMarketAccumulators,
          row,
          accumulator,
        );

        marketSummaryRows++;
      }

      marketAccumulators =
        new Map<
          string,
          MarketAccumulator
        >();
    };

  try {
    await writeToStream(
      summaryStream,
      getCsvLine(SUMMARY_HEADERS),
    );

    for await (const line of reader) {
      if (columns === null) {
        columns =
          getSourceColumns(line);

        continue;
      }

      if (line.length === 0) {
        continue;
      }

      const values =
        parseCsvLine(line);

      const market =
        values[columns.market];

      if (!market) {
        continue;
      }

      if (
        currentMarket !== null &&
        market !== currentMarket
      ) {
        await flushMarket();
      }

      currentMarket = market;

      const range =
        ranges.get(market);

      if (!range) {
        throw new Error(
          `Time range not found for market: ${market}`,
        );
      }

      const receivedAt =
        Number(
          values[columns.receivedAt],
        );

      const horizonMs =
        Number(
          values[columns.horizonMs],
        );

      const absoluteNormalizedSpeed =
        Number(
          values[
            columns.absoluteNormalizedSpeed
          ],
        );

      const relativeAcceleration =
        Number(
          values[
            columns.relativeAcceleration
          ],
        );

      const alignedSurprise =
        Number(
          values[
            columns.alignedSurprise
          ],
        );

      const alignedReturnPermille =
        Number(
          values[
            columns.alignedReturnPermille
          ],
        );

      const mfePermille =
        Number(
          values[columns.mfePermille],
        );

      const mfeAtMs =
        Number(
          values[columns.mfeAtMs],
        );

      const maePermille =
        Number(
          values[columns.maePermille],
        );

      const maeAtMs =
        Number(
          values[columns.maeAtMs],
        );

      if (
        !Number.isFinite(receivedAt) ||
        !Number.isFinite(horizonMs) ||
        !Number.isFinite(
          absoluteNormalizedSpeed,
        ) ||
        !Number.isFinite(
          relativeAcceleration,
        ) ||
        !Number.isFinite(
          alignedSurprise,
        ) ||
        !Number.isFinite(
          alignedReturnPermille,
        ) ||
        !Number.isFinite(mfePermille) ||
        !Number.isFinite(mfeAtMs) ||
        !Number.isFinite(maePermille) ||
        !Number.isFinite(maeAtMs)
      ) {
        continue;
      }

      let split: Split;

      if (
        receivedAt + horizonMs <
        range.splitAt
      ) {
        split = 'train';
        usedTrainSamples++;
      } else if (
        receivedAt >=
        range.splitAt
      ) {
        split = 'test';
        usedTestSamples++;
      } else {
        purgedSamples++;
        continue;
      }

      addMarketSample(
        marketAccumulators,
        split,
        market,
        horizonMs,
        absoluteNormalizedSpeed,
        relativeAcceleration,
        alignedSurprise,
        alignedReturnPermille,
        mfePermille,
        mfeAtMs,
        maePermille,
        maeAtMs,
      );
    }

    await flushMarket();
  } finally {
    await closeStream(
      summaryStream,
    );
  }

  const crossMarketStream =
    createWriteStream(
      CROSS_MARKET_PATH,
      { encoding: 'utf8' },
    );

  try {
    await writeToStream(
      crossMarketStream,
      getCsvLine(
        CROSS_MARKET_HEADERS,
      ),
    );

    const rows =
      [
        ...crossMarketAccumulators
          .values(),
      ].map(
        crossMarketAccumulatorToRow,
      );

    rows.sort(
      (a, b) =>
        a.split.localeCompare(
          b.split,
        ) ||
        a.horizonMs - b.horizonMs ||
        a.normalizedSpeedBin.localeCompare(
          b.normalizedSpeedBin,
        ) ||
        a.relativeAccelerationBin.localeCompare(
          b.relativeAccelerationBin,
        ) ||
        a.alignedSurpriseBin.localeCompare(
          b.alignedSurpriseBin,
        ),
    );

    for (const row of rows) {
      await writeToStream(
        crossMarketStream,
        getCrossMarketCsvLine(
          row,
        ),
      );
    }

    return {
      usedTrainSamples,
      usedTestSamples,
      purgedSamples,
      marketSummaryRows,
      crossMarketRows:
        rows.length,
    };
  } finally {
    await closeStream(
      crossMarketStream,
    );
  }
};

const main = async (): Promise<void> => {
  const startTime = Date.now();

  await mkdir(
    OUTPUT_DIRECTORY,
    { recursive: true },
  );

  console.log(
    `Source: ${SOURCE_PATH}`,
  );

  console.log(
    `Train fraction: ${TRAIN_FRACTION}`,
  );

  console.log(
    'Pass 1/2: scanning market time ranges...',
  );

  const {
    ranges,
    sourceRows,
  } = await scanMarketTimeRanges();

  console.log(
    `Found ${ranges.size} markets, ` +
    `${sourceRows} source rows.`,
  );

  await writeSplitRanges(ranges);

  console.log(
    'Pass 2/2: aggregating train/test samples...',
  );

  const result =
    await aggregateSamples(ranges);

  const elapsedMinutes =
    (
      (Date.now() - startTime) /
      60_000
    ).toFixed(1);

  await writeFile(
    METADATA_PATH,
    JSON.stringify(
      {
        generatedAt:
          new Date().toISOString(),

        sourceRunId:
          SOURCE_RUN_ID,

        runId:
          RUN_ID,

        sourcePath:
          SOURCE_PATH,

        trainFraction:
          TRAIN_FRACTION,

        splitRule: {
          splitAt:
            'minReceivedAt + trainFraction * ' +
            '(maxReceivedAt - minReceivedAt)',

          train:
            'receivedAt + horizonMs < splitAt',

          test:
            'receivedAt >= splitAt',

          purge:
            'samples whose future horizon crosses splitAt',
        },

        normalizedSpeedBoundaries:
          NORMALIZED_SPEED_BOUNDARIES,

        relativeAccelerationBoundaries:
          RELATIVE_ACCELERATION_BOUNDARIES,

        alignedSurpriseBoundaries:
          ALIGNED_SURPRISE_BOUNDARIES,

        markets:
          ranges.size,

        sourceRows,

        usedTrainSamples:
          result.usedTrainSamples,

        usedTestSamples:
          result.usedTestSamples,

        purgedSamples:
          result.purgedSamples,

        marketSummaryRows:
          result.marketSummaryRows,

        crossMarketRows:
          result.crossMarketRows,

        elapsedMinutes:
          Number(elapsedMinutes),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log('');
  console.log('Done.');
  console.log(
    `Train samples: ${result.usedTrainSamples}`,
  );
  console.log(
    `Test samples: ${result.usedTestSamples}`,
  );
  console.log(
    `Purged samples: ${result.purgedSamples}`,
  );
  console.log(
    `Total time: ${elapsedMinutes} minutes`,
  );

  console.log('');
  console.log(
    `Summary: ${SUMMARY_PATH}`,
  );
  console.log(
    `Cross-market: ${CROSS_MARKET_PATH}`,
  );
  console.log(
    `Splits: ${SPLITS_PATH}`,
  );
  console.log(
    `Metadata: ${METADATA_PATH}`,
  );
};

await main();
