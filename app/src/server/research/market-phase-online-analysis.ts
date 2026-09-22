// app/src/server/research/market-phase-online-analysis.ts

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
import {
  TIME_DERIVATIVE_SCALE,
} from '../../shared/constants/time-derivatives.js';
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

const PHASE_TAU_TIME =
  PHASE_TAU / TIME_DERIVATIVE_SCALE;

const HORIZONS = [
  10 * SECONDS,
  30 * SECONDS,
  1 * MINUTE,
  2 * MINUTE,
  5 * MINUTE,
] as const;

const MAX_TARGET_DELAY = 10 * SECONDS;

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

const ABSOLUTE_SURPRISE_BOUNDARIES = [
  0.25,
  0.5,
  0.75,
  1,
  1.5,
  2,
  3,
  5,
] as const;

const DISTRIBUTION_QUANTILES = [
  0.01,
  0.05,
  0.1,
  0.2,
  0.25,
  0.5,
  0.75,
  0.8,
  0.9,
  0.95,
  0.99,
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
  'online',
  formatDuration(RESPONSE_TIME),
  `d${formatDuration(MAX_TARGET_DELAY)}`,
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

const ABSOLUTE_SURPRISE_PATH = resolve(
  OUTPUT_DIRECTORY,
  `absolute-surprise-${RUN_ID}.csv`,
);

const DISTRIBUTIONS_PATH = resolve(
  OUTPUT_DIRECTORY,
  `distributions-${RUN_ID}.csv`,
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
  residualVariance: number;
}

interface OnlineFeatures {
  residualScale: number;

  normalizedSpeed: number;
  absoluteNormalizedSpeed: number;

  normalizedAcceleration: number;
  relativeAcceleration: number;

  alignedSurprise: number;
  absoluteSurprise: number;
}

interface AnalysisSample
extends Observation, OnlineFeatures {
  market: string;

  horizonMs: number;
  targetDelayMs: number;

  returnPermille: number;
  alignedReturnPermille: number;

  mfePermille: number;
  mfeAtMs: number;

  maePermille: number;
  maeAtMs: number;
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

  normalizedSpeedBinIndex: number;
  relativeAccelerationBinIndex: number;
  alignedSurpriseBinIndex: number;
}

interface SummaryRow {
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

interface AbsoluteSurpriseAccumulator
extends StatisticsAccumulator {
  market: string;
  horizonMs: number;

  normalizedSpeedBinIndex: number;
  relativeAccelerationBinIndex: number;
  absoluteSurpriseBinIndex: number;
}

interface AbsoluteSurpriseRow {
  market: string;
  horizonMs: number;

  normalizedSpeedBin: string;
  relativeAccelerationBin: string;
  absoluteSurpriseBin: string;

  count: number;

  meanAlignedReturnPermille: number;
  stdDevAlignedReturnPermille: number;
  positiveRate: number;

  meanMfePermille: number;
  meanMfeAtMs: number;

  meanMaePermille: number;
  meanMaeAtMs: number;
}

interface DistributionValues {
  normalizedSpeed: number[];
  normalizedAcceleration: number[];
  relativeAcceleration: number[];
  alignedSurprise: number[];
  absoluteSurprise: number[];
}

interface DistributionRow {
  market: string;
  count: number;

  normalizedSpeed: number[];
  normalizedAcceleration: number[];
  relativeAcceleration: number[];
  alignedSurprise: number[];
  absoluteSurprise: number[];
}

const SAMPLE_HEADERS = [
  'market',
  'receivedAt',
  'horizonMs',
  'targetDelayMs',

  'price',
  'speed',
  'acceleration',
  'surprise',
  'residualVariance',

  'residualScale',
  'normalizedSpeed',
  'absoluteNormalizedSpeed',
  'normalizedAcceleration',
  'relativeAcceleration',
  'alignedSurprise',
  'absoluteSurprise',

  'returnPermille',
  'alignedReturnPermille',

  'mfePermille',
  'mfeAtMs',

  'maePermille',
  'maeAtMs',
] as const;

const SUMMARY_HEADERS = [
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

const ABSOLUTE_SURPRISE_HEADERS = [
  'market',
  'horizonMs',
  'normalizedSpeedBin',
  'relativeAccelerationBin',
  'absoluteSurpriseBin',
  'count',
  'meanAlignedReturnPermille',
  'stdDevAlignedReturnPermille',
  'positiveRate',
  'meanMfePermille',
  'meanMfeAtMs',
  'meanMaePermille',
  'meanMaeAtMs',
] as const;

const DISTRIBUTION_FEATURE_NAMES = [
  'normalizedSpeed',
  'normalizedAcceleration',
  'relativeAcceleration',
  'alignedSurprise',
  'absoluteSurprise',
] as const;

const DISTRIBUTION_HEADERS = [
  'market',
  'count',

  ...DISTRIBUTION_FEATURE_NAMES.flatMap(
    (featureName) =>
      DISTRIBUTION_QUANTILES.map(
        (quantile) =>
          `${featureName}P${quantile * 100}`,
      ),
  ),
] as const;

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

const calculateOnlineFeatures = (
  observation: Observation,
): OnlineFeatures | null => {
  const {
    speed,
    acceleration,
    surprise,
    residualVariance,
  } = observation;

  if (
    speed === 0 ||
    !Number.isFinite(speed) ||
    !Number.isFinite(acceleration) ||
    !Number.isFinite(surprise) ||
    !Number.isFinite(residualVariance) ||
    residualVariance <= 0
  ) {
    return null;
  }

  const residualScale =
    Math.sqrt(residualVariance);

  if (
    !Number.isFinite(residualScale) ||
    residualScale <= 0
  ) {
    return null;
  }

  const normalizedSpeed =
    speed *
    PHASE_TAU_TIME /
    residualScale;

  const normalizedAcceleration =
    acceleration *
    PHASE_TAU_TIME *
    PHASE_TAU_TIME /
    residualScale;

  const relativeAcceleration =
    acceleration *
    PHASE_TAU_TIME /
    speed;

  const alignedSurprise =
    surprise * Math.sign(speed);

  const features = {
    residualScale,

    normalizedSpeed,
    absoluteNormalizedSpeed:
      Math.abs(normalizedSpeed),

    normalizedAcceleration,
    relativeAcceleration,

    alignedSurprise,
    absoluteSurprise:
      Math.abs(surprise),
  };

  if (
    !Number.isFinite(
      features.normalizedSpeed,
    ) ||
    !Number.isFinite(
      features.absoluteNormalizedSpeed,
    ) ||
    !Number.isFinite(
      features.normalizedAcceleration,
    ) ||
    !Number.isFinite(
      features.relativeAcceleration,
    ) ||
    !Number.isFinite(
      features.alignedSurprise,
    ) ||
    !Number.isFinite(
      features.absoluteSurprise,
    )
  ) {
    return null;
  }

  return features;
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

const getCsvLine = (
  values: readonly (string | number)[],
): string =>
  values.map(escapeCsv).join(',') + '\n';

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

          residualVariance:
            phaseValue.residualVariance,
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
  const samples: AnalysisSample[] = [];

  for (
    let index = 0;
    index < observations.length;
    index++
  ) {
    const current =
      observations[index];

    if (
      !Number.isFinite(current.price) ||
      current.price <= 0
    ) {
      continue;
    }

    const features =
      calculateOnlineFeatures(current);

    if (!features) {
      continue;
    }

    const direction =
      Math.sign(current.speed);

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

      samples.push({
        market: marketName,

        ...current,
        ...features,

        horizonMs:
          horizon,

        targetDelayMs:
          targetDelay,

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

  return samples;
};

const addSummarySample = (
  accumulators:
    Map<string, SummaryAccumulator>,
  market: string,
  sample: AnalysisSample,
): void => {
  const normalizedSpeedBinIndex =
    getBinIndex(
      sample.absoluteNormalizedSpeed,
      NORMALIZED_SPEED_BOUNDARIES,
    );

  const relativeAccelerationBinIndex =
    getBinIndex(
      sample.relativeAcceleration,
      RELATIVE_ACCELERATION_BOUNDARIES,
    );

  const alignedSurpriseBinIndex =
    getBinIndex(
      sample.alignedSurprise,
      ALIGNED_SURPRISE_BOUNDARIES,
    );

  const key = [
    market,
    sample.horizonMs,
    normalizedSpeedBinIndex,
    relativeAccelerationBinIndex,
    alignedSurpriseBinIndex,
  ].join('|');

  let accumulator =
    accumulators.get(key);

  if (!accumulator) {
    accumulator = {
      ...createStatisticsAccumulator(),

      market,

      horizonMs:
        sample.horizonMs,

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
  const normalizedSpeedBinIndex =
    getBinIndex(
      sample.absoluteNormalizedSpeed,
      NORMALIZED_SPEED_BOUNDARIES,
    );

  const relativeAccelerationBinIndex =
    getBinIndex(
      sample.relativeAcceleration,
      RELATIVE_ACCELERATION_BOUNDARIES,
    );

  const absoluteSurpriseBinIndex =
    getBinIndex(
      sample.absoluteSurprise,
      ABSOLUTE_SURPRISE_BOUNDARIES,
    );

  const key = [
    market,
    sample.horizonMs,
    normalizedSpeedBinIndex,
    relativeAccelerationBinIndex,
    absoluteSurpriseBinIndex,
  ].join('|');

  let accumulator =
    accumulators.get(key);

  if (!accumulator) {
    accumulator = {
      ...createStatisticsAccumulator(),

      market,

      horizonMs:
        sample.horizonMs,

      normalizedSpeedBinIndex,
      relativeAccelerationBinIndex,
      absoluteSurpriseBinIndex,
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

const buildDistributionRow = (
  market: string,
  observations: readonly Observation[],
): DistributionRow => {
  const values: DistributionValues = {
    normalizedSpeed: [],
    normalizedAcceleration: [],
    relativeAcceleration: [],
    alignedSurprise: [],
    absoluteSurprise: [],
  };

  for (const observation of observations) {
    const features =
      calculateOnlineFeatures(
        observation,
      );

    if (!features) {
      continue;
    }

    values.normalizedSpeed.push(
      features.absoluteNormalizedSpeed,
    );

    values.normalizedAcceleration.push(
      features.normalizedAcceleration,
    );

    values.relativeAcceleration.push(
      features.relativeAcceleration,
    );

    values.alignedSurprise.push(
      features.alignedSurprise,
    );

    values.absoluteSurprise.push(
      features.absoluteSurprise,
    );
  }

  const valueArrays: number[][] = [
    values.normalizedSpeed,
    values.normalizedAcceleration,
    values.relativeAcceleration,
    values.alignedSurprise,
    values.absoluteSurprise,
  ];

  for (const valueArray of valueArrays) {
    valueArray.sort(
      (a, b) => a - b,
    );
  }

  const getQuantiles = (
    sorted: readonly number[],
  ): number[] =>
    DISTRIBUTION_QUANTILES.map(
      (quantile) =>
        getDistributionQuantile(
          sorted,
          quantile,
        ),
    );

  return {
    market,

    count:
      values.normalizedSpeed.length,

    normalizedSpeed:
      getQuantiles(
        values.normalizedSpeed,
      ),

    normalizedAcceleration:
      getQuantiles(
        values.normalizedAcceleration,
      ),

    relativeAcceleration:
      getQuantiles(
        values.relativeAcceleration,
      ),

    alignedSurprise:
      getQuantiles(
        values.alignedSurprise,
      ),

    absoluteSurprise:
      getQuantiles(
        values.absoluteSurprise,
      ),
  };
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
  }));
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

    absoluteSurpriseBin:
      getBinName(
        ABSOLUTE_SURPRISE_BOUNDARIES,
        accumulator
          .absoluteSurpriseBinIndex,
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
  }));
};

const getSampleCsvLine = (
  sample: AnalysisSample,
): string => {
  return getCsvLine([
    sample.market,
    sample.receivedAt,
    sample.horizonMs,
    sample.targetDelayMs,

    toFiniteString(sample.price),
    toFiniteString(sample.speed),
    toFiniteString(sample.acceleration),
    toFiniteString(sample.surprise),
    toFiniteString(sample.residualVariance),

    toFiniteString(sample.residualScale),
    toFiniteString(sample.normalizedSpeed),
    toFiniteString(
      sample.absoluteNormalizedSpeed,
    ),
    toFiniteString(
      sample.normalizedAcceleration,
    ),
    toFiniteString(
      sample.relativeAcceleration,
    ),
    toFiniteString(
      sample.alignedSurprise,
    ),
    toFiniteString(
      sample.absoluteSurprise,
    ),

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
  ]);
};

const getSummaryCsvLine = (
  row: SummaryRow,
): string => {
  return getCsvLine([
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

const getAbsoluteSurpriseCsvLine = (
  row: AbsoluteSurpriseRow,
): string => {
  return getCsvLine([
    row.market,
    row.horizonMs,
    row.normalizedSpeedBin,
    row.relativeAccelerationBin,
    row.absoluteSurpriseBin,
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

const getDistributionCsvLine = (
  row: DistributionRow,
): string => {
  return getCsvLine([
    row.market,
    row.count,

    ...DISTRIBUTION_FEATURE_NAMES.flatMap(
      (featureName) =>
        row[featureName].map(
          toFiniteString,
        ),
    ),
  ]);
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

const writeSummaryRows = async (
  stream: WriteStream,
  rows: readonly SummaryRow[],
): Promise<void> => {
  let chunk = '';

  for (const row of rows) {
    chunk += getSummaryCsvLine(row);
  }

  if (chunk.length > 0) {
    await writeToStream(
      stream,
      chunk,
    );
  }
};

const writeAbsoluteSurpriseRows = async (
  stream: WriteStream,
  rows: readonly AbsoluteSurpriseRow[],
): Promise<void> => {
  let chunk = '';

  for (const row of rows) {
    chunk +=
      getAbsoluteSurpriseCsvLine(row);
  }

  if (chunk.length > 0) {
    await writeToStream(
      stream,
      chunk,
    );
  }
};

const main = async (): Promise<void> => {
  const startTime = Date.now();

  serverGlobalStateService.start();
  entityManager.start();

  await mkdir(
    OUTPUT_DIRECTORY,
    { recursive: true },
  );

  const marketNames =
    await storageDao
      .getArchiveMarketNames();

  /*
   * Only pooled accumulators survive between markets.
   * Market-specific accumulators are created and flushed
   * during each market iteration.
   */
  const pooledSummaryAccumulators =
    new Map<
      string,
      SummaryAccumulator
    >();

  const pooledAbsoluteSurpriseAccumulators =
    new Map<
      string,
      AbsoluteSurpriseAccumulator
    >();

  const samplesStream =
    createWriteStream(
      SAMPLES_PATH,
      { encoding: 'utf8' },
    );

  const summaryStream =
    createWriteStream(
      SUMMARY_PATH,
      { encoding: 'utf8' },
    );

  const absoluteSurpriseStream =
    createWriteStream(
      ABSOLUTE_SURPRISE_PATH,
      { encoding: 'utf8' },
    );

  const distributionsStream =
    createWriteStream(
      DISTRIBUTIONS_PATH,
      { encoding: 'utf8' },
    );

  await Promise.all([
    writeToStream(
      samplesStream,
      getCsvLine(SAMPLE_HEADERS),
    ),

    writeToStream(
      summaryStream,
      getCsvLine(SUMMARY_HEADERS),
    ),

    writeToStream(
      absoluteSurpriseStream,
      getCsvLine(
        ABSOLUTE_SURPRISE_HEADERS,
      ),
    ),

    writeToStream(
      distributionsStream,
      getCsvLine(
        DISTRIBUTION_HEADERS,
      ),
    ),
  ]);

  console.log(
    `Run: ${RUN_ID}`,
  );

  console.log(
    `Analyzing ${marketNames.length} ` +
    'archived markets...',
  );

  let totalObservations = 0;
  let totalSamples = 0;
  let totalSummaryRows = 0;
  let totalAbsoluteSurpriseRows = 0;

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

      const distribution =
        buildDistributionRow(
          marketName,
          observations,
        );

      await writeToStream(
        distributionsStream,
        getDistributionCsvLine(
          distribution,
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

      const marketSummaryAccumulators =
        new Map<
          string,
          SummaryAccumulator
        >();

      const marketAbsoluteSurpriseAccumulators =
        new Map<
          string,
          AbsoluteSurpriseAccumulator
        >();

      for (const sample of marketSamples) {
        addSummarySample(
          marketSummaryAccumulators,
          marketName,
          sample,
        );

        addSummarySample(
          pooledSummaryAccumulators,
          '*',
          sample,
        );

        addAbsoluteSurpriseSample(
          marketAbsoluteSurpriseAccumulators,
          marketName,
          sample,
        );

        addAbsoluteSurpriseSample(
          pooledAbsoluteSurpriseAccumulators,
          '*',
          sample,
        );
      }

      const marketSummaryRows =
        getSummaryRows(
          marketSummaryAccumulators,
        );

      const marketAbsoluteSurpriseRows =
        getAbsoluteSurpriseRows(
          marketAbsoluteSurpriseAccumulators,
        );

      await writeSummaryRows(
        summaryStream,
        marketSummaryRows,
      );

      await writeAbsoluteSurpriseRows(
        absoluteSurpriseStream,
        marketAbsoluteSurpriseRows,
      );

      totalObservations +=
        observations.length;

      totalSamples +=
        marketSamples.length;

      totalSummaryRows +=
        marketSummaryRows.length;

      totalAbsoluteSurpriseRows +=
        marketAbsoluteSurpriseRows.length;

      console.log(
        `[${marketIndex + 1}/` +
        `${marketNames.length}] ` +
        `${marketName}: ` +
        `${observations.length} observations, ` +
        `${marketSamples.length} samples`,
      );
    }

    /*
     * Pooled rows are written only once, after every
     * market has contributed to the accumulators.
     */
    const pooledSummaryRows =
      getSummaryRows(
        pooledSummaryAccumulators,
      );

    const pooledAbsoluteSurpriseRows =
      getAbsoluteSurpriseRows(
        pooledAbsoluteSurpriseAccumulators,
      );

    await writeSummaryRows(
      summaryStream,
      pooledSummaryRows,
    );

    await writeAbsoluteSurpriseRows(
      absoluteSurpriseStream,
      pooledAbsoluteSurpriseRows,
    );

    totalSummaryRows +=
      pooledSummaryRows.length;

    totalAbsoluteSurpriseRows +=
      pooledAbsoluteSurpriseRows.length;
  } finally {
    await Promise.all([
      closeStream(samplesStream),
      closeStream(summaryStream),
      closeStream(
        absoluteSurpriseStream,
      ),
      closeStream(
        distributionsStream,
      ),
    ]);
  }

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

        normalizedSpeedBoundaries:
          NORMALIZED_SPEED_BOUNDARIES,

        relativeAccelerationBoundaries:
          RELATIVE_ACCELERATION_BOUNDARIES,

        alignedSurpriseBoundaries:
          ALIGNED_SURPRISE_BOUNDARIES,

        absoluteSurpriseBoundaries:
          ABSOLUTE_SURPRISE_BOUNDARIES,

        distributionQuantiles:
          DISTRIBUTION_QUANTILES,

        markets:
          marketNames.length,

        observations:
          totalObservations,

        samples:
          totalSamples,

        summaryRows:
          totalSummaryRows,

        absoluteSurpriseRows:
          totalAbsoluteSurpriseRows,

        elapsedMinutes:
          Number(elapsedMinutes),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(
    `Done. ${totalObservations} observations, ` +
    `${totalSamples} samples.`,
  );

  console.log(
    `Total time: ${elapsedMinutes} minutes`,
  );

  console.log(
    `Samples: ${SAMPLES_PATH}`,
  );

  console.log(
    `Summary: ${SUMMARY_PATH}`,
  );

  console.log(
    `Absolute surprise: ${ABSOLUTE_SURPRISE_PATH}`,
  );

  console.log(
    `Distributions: ${DISTRIBUTIONS_PATH}`,
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
