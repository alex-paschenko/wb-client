import 'dotenv/config';

import {
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

import {
  CANDLE_NAME,
} from '../../shared/constants/storage-entities.js';
import {
  MINUTE,
  SECONDS,
} from '../../shared/constants/time.js';
import { Storage } from '../../shared/services/storage.js';
import type {
  MarketCandle,
  MarketPhaseValue,
} from '../../shared/types/data-types.js';
import type {
  LazyArray,
} from '../../shared/utilities/lazy-array.js';
import {
  decodeEntireBinary,
} from '../../shared/utilities/codecs/entire-binary-codec.js';
import { storageDao } from '../dao/storage.js';
import { q } from '../db/client.js';
import { entityManager } from '../services/entity-manager.js';
import {
  serverGlobalStateService,
} from '../services/global-state.js';

const PHASE_NAME = 'phase-30s';

const RESPONSE_TIME = 30 * SECONDS;

const SPEED_RESPONSE_90_TAU_RATIO = 1.401164;

const PHASE_TAU =
  RESPONSE_TIME / SPEED_RESPONSE_90_TAU_RATIO;

const PHASE_TAU_MINUTES =
  PHASE_TAU / MINUTE;

const HORIZONS = [
  10 * SECONDS,
  30 * SECONDS,
  1 * MINUTE,
  2 * MINUTE,
  5 * MINUTE,
] as const;

const MAX_TARGET_DELAY = 10 * SECONDS;

const QUANTILE_COUNT = 5;

const DISTRIBUTION_QUANTILES = [
  0.1,
  0.2,
  0.25,
  0.4,
  0.5,
  0.6,
  0.75,
  0.8,
  0.9,
  0.95,
  0.99,
] as const;

const SURPRISE_BOUNDARIES = [
  0.25,
  0.5,
  0.75,
  1,
  1.5,
  2,
  3,
  5,
] as const;

const NORMALIZED_ACCELERATION_BOUNDARIES = [
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

const formatDuration = (
  duration: number,
): string => {
  if (duration % MINUTE === 0) {
    return `${duration / MINUTE}m`;
  }

  if (duration % SECONDS === 0) {
    return `${duration / SECONDS}s`;
  }

  return `${duration}ms`;
};

const RUN_ID = [
  formatDuration(RESPONSE_TIME),
  `d${formatDuration(MAX_TARGET_DELAY)}`,
  `q${QUANTILE_COUNT}`,
].join('-');

const OUTPUT_DIRECTORY = resolve(
  process.cwd(),
  'research-output/market-phase',
);

const SAMPLES_PATH = resolve(
  OUTPUT_DIRECTORY,
  `samples-${RUN_ID}.csv`,
);

const SUMMARY_PATH = resolve(
  OUTPUT_DIRECTORY,
  `summary-${RUN_ID}.csv`,
);

const DISTRIBUTIONS_PATH = resolve(
  OUTPUT_DIRECTORY,
  `distributions-${RUN_ID}.csv`,
);

const ABSOLUTE_SURPRISE_PATH = resolve(
  OUTPUT_DIRECTORY,
  `absolute-surprise-${RUN_ID}.csv`,
);

const METADATA_PATH = resolve(
  OUTPUT_DIRECTORY,
  `metadata-${RUN_ID}.json`,
);

interface Observation {
  receivedAt: number;
  price: number;

  speed: number;
  acceleration: number;
  surprise: number;
}

type AccelerationMode =
  | 'accelerating'
  | 'decelerating'
  | 'neutral';

interface PreliminarySample {
  market: string;
  receivedAt: number;

  horizonMs: number;
  targetDelayMs: number;

  speed: number;
  acceleration: number;
  normalizedAcceleration: number;
  surprise: number;

  accelerationMode: AccelerationMode;

  returnPermille: number;
  alignedReturnPermille: number;

  mfePermille: number;
  mfeAtMs: number;

  maePermille: number;
  maeAtMs: number;
}

interface AnalysisSample extends PreliminarySample {
  speedQuantile: number;
  surpriseQuantile: number;
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

interface SummaryAccumulator
  extends StatisticsAccumulator {
  market: string;
  horizonMs: number;

  accelerationMode: AccelerationMode;

  speedQuantile: number;
  surpriseQuantile: number;
}

interface SummaryRow {
  market: string;
  horizonMs: number;

  accelerationMode: AccelerationMode;

  speedQuantile: number;
  surpriseQuantile: number;

  count: number;

  meanAlignedReturnPermille: number;
  stdDevAlignedReturnPermille: number;
  positiveRate: number;

  meanMfePermille: number;
  meanMfeAtMs: number;

  meanMaePermille: number;
  meanMaeAtMs: number;
}

interface AbsoluteSurpriseAccumulator
  extends StatisticsAccumulator {
  market: string;
  horizonMs: number;

  speedQuantile: number;

  surpriseBinIndex: number;
  normalizedAccelerationBinIndex: number;
}

interface AbsoluteSurpriseRow {
  market: string;
  horizonMs: number;

  speedQuantile: number;

  surpriseBin: string;
  normalizedAccelerationBin: string;

  count: number;

  meanAlignedReturnPermille: number;
  stdDevAlignedReturnPermille: number;
  positiveRate: number;

  meanMfePermille: number;
  meanMfeAtMs: number;

  meanMaePermille: number;
  meanMaeAtMs: number;
}

interface DistributionRow {
  market: string;
  count: number;

  speedQuantiles: number[];
  surpriseQuantiles: number[];
}

const lowerBoundReceivedAt = (
  observations: readonly Observation[],
  receivedAt: number,
  startIndex: number,
): number => {
  let low = startIndex;
  let high = observations.length;

  while (low < high) {
    const middle =
      low + Math.floor((high - low) / 2);

    if (
      observations[middle].receivedAt <
      receivedAt
    ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
};

const getAccelerationMode = (
  speed: number,
  acceleration: number,
): AccelerationMode => {
  const alignedAcceleration =
    acceleration * Math.sign(speed);

  if (alignedAcceleration > 0) {
    return 'accelerating';
  }

  if (alignedAcceleration < 0) {
    return 'decelerating';
  }

  return 'neutral';
};

const getQuantileBoundaries = (
  values: readonly number[],
): number[] => {
  if (values.length === 0) {
    return [];
  }

  const sorted =
    [...values].sort((a, b) => a - b);

  const boundaries: number[] = [];

  for (
    let quantile = 1;
    quantile < QUANTILE_COUNT;
    quantile++
  ) {
    const index =
      Math.ceil(
        quantile *
        sorted.length /
        QUANTILE_COUNT,
      ) - 1;

    boundaries.push(
      sorted[Math.max(0, index)],
    );
  }

  return boundaries;
};

const getQuantile = (
  value: number,
  boundaries: readonly number[],
): number => {
  for (
    let index = 0;
    index < boundaries.length;
    index++
  ) {
    if (value <= boundaries[index]) {
      return index + 1;
    }
  }

  return boundaries.length + 1;
};

const getDistributionQuantile = (
  sorted: readonly number[],
  quantile: number,
): number => {
  if (sorted.length === 0) {
    return Number.NaN;
  }

  const position =
    (sorted.length - 1) * quantile;

  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  if (lower === upper) {
    return sorted[lower];
  }

  const fraction =
    position - lower;

  return (
    sorted[lower] * (1 - fraction) +
    sorted[upper] * fraction
  );
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

const formatBoundary = (
  value: number,
): string =>
  String(value);

const getBinName = (
  boundaries: readonly number[],
  index: number,
): string => {
  if (index === 0) {
    return `<${formatBoundary(
      boundaries[0],
    )}`;
  }

  if (index === boundaries.length) {
    return `>=${formatBoundary(
      boundaries[
        boundaries.length - 1
      ],
    )}`;
  }

  return (
    `${formatBoundary(
      boundaries[index - 1],
    )}..` +
    `${formatBoundary(
      boundaries[index],
    )}`
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
  sample: AnalysisSample,
): void => {
  const alignedReturn =
    sample.alignedReturnPermille;

  accumulator.count += 1;

  accumulator.positiveCount +=
    Number(alignedReturn > 0);

  accumulator.alignedReturnSum +=
    alignedReturn;

  accumulator.alignedReturnSquaredSum +=
    alignedReturn * alignedReturn;

  accumulator.mfeSum +=
    sample.mfePermille;

  accumulator.mfeAtSum +=
    sample.mfeAtMs;

  accumulator.maeSum +=
    sample.maePermille;

  accumulator.maeAtSum +=
    sample.maeAtMs;
};

const getMean = (
  sum: number,
  count: number,
): number =>
  sum / count;

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

const toFiniteString = (
  value: number,
): string =>
  Number.isFinite(value)
    ? String(value)
    : '';

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

const rowsToCsv = (
  headers: readonly string[],
  rows: readonly (
    readonly (string | number)[]
  )[],
): string => {
  const lines = [
    headers.map(escapeCsv).join(','),
    ...rows.map(
      (row) =>
        row.map(escapeCsv).join(','),
    ),
  ];

  return `${lines.join('\n')}\n`;
};

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

const loadMarketObservations = async (
  marketName: string,
): Promise<Observation[]> => {
  const snapshots =
    await storageDao.getArchiveByMarketName(
      marketName,
    );

  const observationsByReceivedAt =
    new Map<number, Observation>();

  for (const snapshot of snapshots) {
    const entire =
      decodeEntireBinary(snapshot.data);

    const storage =
      new Storage(marketName);

    storage.applySnapshot({
      codecName: entire.codecName,
      data: entire.data,
    });

    const accessors =
      storage.getAccessors();

    const candles =
      accessors.candles[CANDLE_NAME] as
        LazyArray<MarketCandle>;

    const phase =
      accessors.indicators[PHASE_NAME] as
        LazyArray<MarketPhaseValue> |
        undefined;

    if (!phase) {
      throw new Error(
        `Indicator "${PHASE_NAME}" not found ` +
        `for market "${marketName}"`,
      );
    }

    for (
      let index = 0;
      index < storage.size;
      index++
    ) {
      const candle =
        candles.get(index);

      const phaseValue =
        phase.get(index);

      observationsByReceivedAt.set(
        candle.receivedAt,
        {
          receivedAt:
            candle.receivedAt,

          price:
            candle.price,

          speed:
            phaseValue.speed,

          acceleration:
            phaseValue.acceleration,

          surprise:
            phaseValue.surprise,
        },
      );
    }
  }

  return [
    ...observationsByReceivedAt.values(),
  ].sort(
    (a, b) =>
      a.receivedAt - b.receivedAt,
  );
};

const buildMarketSamples = (
  marketName: string,
  observations: readonly Observation[],
): AnalysisSample[] => {
  const preliminary:
    PreliminarySample[] = [];

  for (
    let index = 0;
    index < observations.length;
    index++
  ) {
    const current =
      observations[index];

    if (
      current.speed === 0 ||
      !Number.isFinite(current.price) ||
      current.price <= 0
    ) {
      continue;
    }

    const direction =
      Math.sign(current.speed);

    const normalizedAcceleration =
      current.acceleration *
      PHASE_TAU_MINUTES /
      current.speed;

    for (const horizon of HORIZONS) {
      const targetAt =
        current.receivedAt + horizon;

      const targetIndex =
        lowerBoundReceivedAt(
          observations,
          targetAt,
          index + 1,
        );

      if (
        targetIndex >=
        observations.length
      ) {
        continue;
      }

      const target =
        observations[targetIndex];

      const targetDelay =
        target.receivedAt - targetAt;

      if (
        targetDelay >
        MAX_TARGET_DELAY
      ) {
        continue;
      }

      const returnPermille =
        1000 *
        Math.log(
          target.price /
          current.price,
        );

      let mfePermille =
        Number.NEGATIVE_INFINITY;

      let maePermille =
        Number.POSITIVE_INFINITY;

      let mfeAtMs = 0;
      let maeAtMs = 0;

      for (
        let futureIndex = index + 1;
        futureIndex <
        observations.length;
        futureIndex++
      ) {
        const future =
          observations[futureIndex];

        if (
          future.receivedAt >
          targetAt
        ) {
          break;
        }

        const alignedReturn =
          1000 *
          Math.log(
            future.price /
            current.price,
          ) *
          direction;

        if (
          alignedReturn >
          mfePermille
        ) {
          mfePermille =
            alignedReturn;

          mfeAtMs =
            future.receivedAt -
            current.receivedAt;
        }

        if (
          alignedReturn <
          maePermille
        ) {
          maePermille =
            alignedReturn;

          maeAtMs =
            future.receivedAt -
            current.receivedAt;
        }
      }

      if (
        !Number.isFinite(mfePermille)
      ) {
        mfePermille = 0;
        mfeAtMs = 0;
      }

      if (
        !Number.isFinite(maePermille)
      ) {
        maePermille = 0;
        maeAtMs = 0;
      }

      preliminary.push({
        market: marketName,

        receivedAt:
          current.receivedAt,

        horizonMs:
          horizon,

        targetDelayMs:
          targetDelay,

        speed:
          current.speed,

        acceleration:
          current.acceleration,

        normalizedAcceleration,

        surprise:
          current.surprise,

        accelerationMode:
          getAccelerationMode(
            current.speed,
            current.acceleration,
          ),

        returnPermille,

        alignedReturnPermille:
          returnPermille *
          direction,

        mfePermille,
        mfeAtMs,

        maePermille,
        maeAtMs,
      });
    }
  }

  const stateByReceivedAt =
    new Map<
      number,
      PreliminarySample
    >();

  for (const sample of preliminary) {
    if (
      !stateByReceivedAt.has(
        sample.receivedAt,
      )
    ) {
      stateByReceivedAt.set(
        sample.receivedAt,
        sample,
      );
    }
  }

  const states = [
    ...stateByReceivedAt.values(),
  ];

  const speedBoundaries =
    getQuantileBoundaries(
      states.map(
        (sample) =>
          Math.abs(sample.speed),
      ),
    );

  const surpriseBoundaries =
    getQuantileBoundaries(
      states.map(
        (sample) =>
          Math.abs(sample.surprise),
      ),
    );

  return preliminary.map(
    (sample) => ({
      ...sample,

      speedQuantile:
        getQuantile(
          Math.abs(sample.speed),
          speedBoundaries,
        ),

      surpriseQuantile:
        getQuantile(
          Math.abs(sample.surprise),
          surpriseBoundaries,
        ),
    }),
  );
};

const buildDistributionRow = (
  marketName: string,
  observations: readonly Observation[],
): DistributionRow => {
  const speeds =
    observations
      .map(
        (observation) =>
          Math.abs(observation.speed),
      )
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

  const surprises =
    observations
      .map(
        (observation) =>
          Math.abs(observation.surprise),
      )
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

  return {
    market: marketName,

    count:
      Math.min(
        speeds.length,
        surprises.length,
      ),

    speedQuantiles:
      DISTRIBUTION_QUANTILES.map(
        (quantile) =>
          getDistributionQuantile(
            speeds,
            quantile,
          ),
      ),

    surpriseQuantiles:
      DISTRIBUTION_QUANTILES.map(
        (quantile) =>
          getDistributionQuantile(
            surprises,
            quantile,
          ),
      ),
  };
};

const addSummarySample = (
  accumulators:
    Map<string, SummaryAccumulator>,
  market: string,
  sample: AnalysisSample,
): void => {
  const key = [
    market,
    sample.horizonMs,
    sample.accelerationMode,
    sample.speedQuantile,
    sample.surpriseQuantile,
  ].join('|');

  let accumulator =
    accumulators.get(key);

  if (!accumulator) {
    accumulator = {
      ...createStatisticsAccumulator(),

      market,

      horizonMs:
        sample.horizonMs,

      accelerationMode:
        sample.accelerationMode,

      speedQuantile:
        sample.speedQuantile,

      surpriseQuantile:
        sample.surpriseQuantile,
    };

    accumulators.set(
      key,
      accumulator,
    );
  }

  addStatistics(
    accumulator,
    sample,
  );
};

const addAbsoluteSurpriseSample = (
  accumulators:
    Map<
      string,
      AbsoluteSurpriseAccumulator
    >,
  market: string,
  sample: AnalysisSample,
): void => {
  const surpriseBinIndex =
    getBinIndex(
      Math.abs(sample.surprise),
      SURPRISE_BOUNDARIES,
    );

  const normalizedAccelerationBinIndex =
    getBinIndex(
      sample.normalizedAcceleration,
      NORMALIZED_ACCELERATION_BOUNDARIES,
    );

  const key = [
    market,
    sample.horizonMs,
    sample.speedQuantile,
    surpriseBinIndex,
    normalizedAccelerationBinIndex,
  ].join('|');

  let accumulator =
    accumulators.get(key);

  if (!accumulator) {
    accumulator = {
      ...createStatisticsAccumulator(),

      market,

      horizonMs:
        sample.horizonMs,

      speedQuantile:
        sample.speedQuantile,

      surpriseBinIndex,

      normalizedAccelerationBinIndex,
    };

    accumulators.set(
      key,
      accumulator,
    );
  }

  addStatistics(
    accumulator,
    sample,
  );
};

const getSummaryRows = (
  accumulators:
    ReadonlyMap<
      string,
      SummaryAccumulator
    >,
): SummaryRow[] => {
  return [
    ...accumulators.values(),
  ].map((accumulator) => ({
    market:
      accumulator.market,

    horizonMs:
      accumulator.horizonMs,

    accelerationMode:
      accumulator.accelerationMode,

    speedQuantile:
      accumulator.speedQuantile,

    surpriseQuantile:
      accumulator.surpriseQuantile,

    count:
      accumulator.count,

    meanAlignedReturnPermille:
      getMean(
        accumulator.alignedReturnSum,
        accumulator.count,
      ),

    stdDevAlignedReturnPermille:
      getStandardDeviation(
        accumulator,
      ),

    positiveRate:
      accumulator.positiveCount /
      accumulator.count,

    meanMfePermille:
      getMean(
        accumulator.mfeSum,
        accumulator.count,
      ),

    meanMfeAtMs:
      getMean(
        accumulator.mfeAtSum,
        accumulator.count,
      ),

    meanMaePermille:
      getMean(
        accumulator.maeSum,
        accumulator.count,
      ),

    meanMaeAtMs:
      getMean(
        accumulator.maeAtSum,
        accumulator.count,
      ),
  })).sort(
    (a, b) =>
      a.market.localeCompare(
        b.market,
      ) ||
      a.horizonMs - b.horizonMs ||
      a.accelerationMode.localeCompare(
        b.accelerationMode,
      ) ||
      a.speedQuantile -
        b.speedQuantile ||
      a.surpriseQuantile -
        b.surpriseQuantile,
  );
};

const getAbsoluteSurpriseRows = (
  accumulators:
    ReadonlyMap<
      string,
      AbsoluteSurpriseAccumulator
    >,
): AbsoluteSurpriseRow[] => {
  return [
    ...accumulators.values(),
  ].map((accumulator) => ({
    market:
      accumulator.market,

    horizonMs:
      accumulator.horizonMs,

    speedQuantile:
      accumulator.speedQuantile,

    surpriseBin:
      getBinName(
        SURPRISE_BOUNDARIES,
        accumulator.surpriseBinIndex,
      ),

    normalizedAccelerationBin:
      getBinName(
        NORMALIZED_ACCELERATION_BOUNDARIES,
        accumulator
          .normalizedAccelerationBinIndex,
      ),

    count:
      accumulator.count,

    meanAlignedReturnPermille:
      getMean(
        accumulator.alignedReturnSum,
        accumulator.count,
      ),

    stdDevAlignedReturnPermille:
      getStandardDeviation(
        accumulator,
      ),

    positiveRate:
      accumulator.positiveCount /
      accumulator.count,

    meanMfePermille:
      getMean(
        accumulator.mfeSum,
        accumulator.count,
      ),

    meanMfeAtMs:
      getMean(
        accumulator.mfeAtSum,
        accumulator.count,
      ),

    meanMaePermille:
      getMean(
        accumulator.maeSum,
        accumulator.count,
      ),

    meanMaeAtMs:
      getMean(
        accumulator.maeAtSum,
        accumulator.count,
      ),
  })).sort(
    (a, b) =>
      a.market.localeCompare(
        b.market,
      ) ||
      a.horizonMs - b.horizonMs ||
      a.speedQuantile -
        b.speedQuantile ||
      getBinIndexFromName(
        a.surpriseBin,
        SURPRISE_BOUNDARIES,
      ) -
        getBinIndexFromName(
          b.surpriseBin,
          SURPRISE_BOUNDARIES,
        ) ||
      getBinIndexFromName(
        a.normalizedAccelerationBin,
        NORMALIZED_ACCELERATION_BOUNDARIES,
      ) -
        getBinIndexFromName(
          b.normalizedAccelerationBin,
          NORMALIZED_ACCELERATION_BOUNDARIES,
        ),
  );
};

const getBinIndexFromName = (
  name: string,
  boundaries: readonly number[],
): number => {
  for (
    let index = 0;
    index <= boundaries.length;
    index++
  ) {
    if (
      getBinName(
        boundaries,
        index,
      ) === name
    ) {
      return index;
    }
  }

  throw new Error(
    `Unknown bin "${name}"`,
  );
};

const SAMPLE_HEADERS = [
  'market',
  'receivedAt',
  'horizonMs',
  'targetDelayMs',
  'speed',
  'acceleration',
  'normalizedAcceleration',
  'surprise',
  'speedQuantile',
  'surpriseQuantile',
  'accelerationMode',
  'returnPermille',
  'alignedReturnPermille',
  'mfePermille',
  'mfeAtMs',
  'maePermille',
  'maeAtMs',
] as const;

const getSampleCsvLine = (
  sample: AnalysisSample,
): string => {
  return [
    sample.market,
    sample.receivedAt,
    sample.horizonMs,
    sample.targetDelayMs,

    toFiniteString(
      sample.speed,
    ),

    toFiniteString(
      sample.acceleration,
    ),

    toFiniteString(
      sample.normalizedAcceleration,
    ),

    toFiniteString(
      sample.surprise,
    ),

    sample.speedQuantile,
    sample.surpriseQuantile,
    sample.accelerationMode,

    toFiniteString(
      sample.returnPermille,
    ),

    toFiniteString(
      sample.alignedReturnPermille,
    ),

    toFiniteString(
      sample.mfePermille,
    ),

    sample.mfeAtMs,

    toFiniteString(
      sample.maePermille,
    ),

    sample.maeAtMs,
  ].map(escapeCsv).join(',') + '\n';
};

const writeMarketSamples = async (
  stream: WriteStream,
  samples: readonly AnalysisSample[],
): Promise<void> => {
  const CHUNK_SIZE = 10_000;

  for (
    let startIndex = 0;
    startIndex < samples.length;
    startIndex += CHUNK_SIZE
  ) {
    const endIndex =
      Math.min(
        startIndex + CHUNK_SIZE,
        samples.length,
      );

    let chunk = '';

    for (
      let index = startIndex;
      index < endIndex;
      index++
    ) {
      chunk += getSampleCsvLine(
        samples[index],
      );
    }

    await writeToStream(
      stream,
      chunk,
    );
  }
};

const writeSummary = async (
  summary: readonly SummaryRow[],
): Promise<void> => {
  const headers = [
    'market',
    'horizonMs',
    'accelerationMode',
    'speedQuantile',
    'surpriseQuantile',
    'count',
    'meanAlignedReturnPermille',
    'stdDevAlignedReturnPermille',
    'positiveRate',
    'meanMfePermille',
    'meanMfeAtMs',
    'meanMaePermille',
    'meanMaeAtMs',
  ];

  const rows = summary.map(
    (row) => [
      row.market,
      row.horizonMs,
      row.accelerationMode,
      row.speedQuantile,
      row.surpriseQuantile,
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
    ],
  );

  await writeFile(
    SUMMARY_PATH,
    rowsToCsv(headers, rows),
    'utf8',
  );
};

const writeAbsoluteSurprise = async (
  summary:
    readonly AbsoluteSurpriseRow[],
): Promise<void> => {
  const headers = [
    'market',
    'horizonMs',
    'speedQuantile',
    'surpriseBin',
    'normalizedAccelerationBin',
    'count',
    'meanAlignedReturnPermille',
    'stdDevAlignedReturnPermille',
    'positiveRate',
    'meanMfePermille',
    'meanMfeAtMs',
    'meanMaePermille',
    'meanMaeAtMs',
  ];

  const rows = summary.map(
    (row) => [
      row.market,
      row.horizonMs,
      row.speedQuantile,
      row.surpriseBin,
      row.normalizedAccelerationBin,
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
    ],
  );

  await writeFile(
    ABSOLUTE_SURPRISE_PATH,
    rowsToCsv(headers, rows),
    'utf8',
  );
};

const writeDistributions = async (
  distributions:
    readonly DistributionRow[],
): Promise<void> => {
  const headers = [
    'market',
    'count',

    ...DISTRIBUTION_QUANTILES.map(
      (quantile) =>
        `speedP${quantile * 100}`,
    ),

    ...DISTRIBUTION_QUANTILES.map(
      (quantile) =>
        `surpriseP${quantile * 100}`,
    ),
  ];

  const rows =
    distributions
      .slice()
      .sort(
        (a, b) =>
          a.market.localeCompare(
            b.market,
          ),
      )
      .map(
        (row) => [
          row.market,
          row.count,

          ...row.speedQuantiles.map(
            toFiniteString,
          ),

          ...row.surpriseQuantiles.map(
            toFiniteString,
          ),
        ],
      );

  await writeFile(
    DISTRIBUTIONS_PATH,
    rowsToCsv(headers, rows),
    'utf8',
  );
};

const main = async (): Promise<void> => {
  serverGlobalStateService.start();
  entityManager.start();

  await mkdir(
    OUTPUT_DIRECTORY,
    { recursive: true },
  );

  const marketNames =
    await storageDao
      .getArchiveMarketNames();

  const summaryAccumulators =
    new Map<
      string,
      SummaryAccumulator
    >();

  const absoluteSurpriseAccumulators =
    new Map<
      string,
      AbsoluteSurpriseAccumulator
    >();

  const distributions:
    DistributionRow[] = [];

  const samplesStream =
    createWriteStream(
      SAMPLES_PATH,
      {
        encoding: 'utf8',
      },
    );

  await writeToStream(
    samplesStream,
    SAMPLE_HEADERS
      .map(escapeCsv)
      .join(',') + '\n',
  );

  console.log(
    `Run: ${RUN_ID}`,
  );

  console.log(
    `Analyzing ${marketNames.length} ` +
    'archived markets...',
  );

  let totalObservations = 0;
  let totalSamples = 0;

  try {
    for (
      const [
        marketIndex,
        marketName,
      ] of marketNames.entries()
    ) {
      const observations =
        await loadMarketObservations(
          marketName,
        );

      distributions.push(
        buildDistributionRow(
          marketName,
          observations,
        ),
      );

      const marketSamples =
        buildMarketSamples(
          marketName,
          observations,
        );

      await writeMarketSamples(
        samplesStream,
        marketSamples,
      );

      for (
        const sample
        of marketSamples
      ) {
        addSummarySample(
          summaryAccumulators,
          sample.market,
          sample,
        );

        addSummarySample(
          summaryAccumulators,
          '*',
          sample,
        );

        addAbsoluteSurpriseSample(
          absoluteSurpriseAccumulators,
          sample.market,
          sample,
        );

        addAbsoluteSurpriseSample(
          absoluteSurpriseAccumulators,
          '*',
          sample,
        );
      }

      totalObservations +=
        observations.length;

      totalSamples +=
        marketSamples.length;

      console.log(
        `[${marketIndex + 1}/` +
        `${marketNames.length}] ` +
        `${marketName}: ` +
        `${observations.length} observations, ` +
        `${marketSamples.length} samples`,
      );
    }
  } finally {
    await closeStream(
      samplesStream,
    );
  }

  const summary =
    getSummaryRows(
      summaryAccumulators,
    );

  const absoluteSurprise =
    getAbsoluteSurpriseRows(
      absoluteSurpriseAccumulators,
    );

  await Promise.all([
    writeSummary(summary),

    writeAbsoluteSurprise(
      absoluteSurprise,
    ),

    writeDistributions(
      distributions,
    ),

    writeFile(
      METADATA_PATH,
      JSON.stringify(
        {
          generatedAt:
            new Date().toISOString(),

          runId:
            RUN_ID,

          phaseName:
            PHASE_NAME,

          responseTimeMs:
            RESPONSE_TIME,

          phaseTauMs:
            PHASE_TAU,

          horizonsMs:
            HORIZONS,

          maxTargetDelayMs:
            MAX_TARGET_DELAY,

          quantileCount:
            QUANTILE_COUNT,

          distributionQuantiles:
            DISTRIBUTION_QUANTILES,

          surpriseBoundaries:
            SURPRISE_BOUNDARIES,

          normalizedAccelerationBoundaries:
            NORMALIZED_ACCELERATION_BOUNDARIES,

          markets:
            marketNames.length,

          observations:
            totalObservations,

          samples:
            totalSamples,

          summaryRows:
            summary.length,

          absoluteSurpriseRows:
            absoluteSurprise.length,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    ),
  ]);

  console.log(
    `Done. ${totalObservations} observations, ` +
    `${totalSamples} samples.`,
  );

  console.log(
    `Samples: ${SAMPLES_PATH}`,
  );

  console.log(
    `Summary: ${SUMMARY_PATH}`,
  );

  console.log(
    `Distributions: ${DISTRIBUTIONS_PATH}`,
  );

  console.log(
    `Absolute surprise: ${ABSOLUTE_SURPRISE_PATH}`,
  );

  console.log(
    `Metadata: ${METADATA_PATH}`,
  );
};

try {
  await main();
} finally {
  serverGlobalStateService.stop();
  await q.end();
}
