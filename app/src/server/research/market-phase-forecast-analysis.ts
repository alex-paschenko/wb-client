// app/src/server/research/market-phase-forecast-analysis.ts

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
const SPLIT_RUN_ID = `${SOURCE_RUN_ID}-s70`;

const OUTPUT_DIRECTORY = resolve(
  process.cwd(),
  'research-output/market-phase',
);

const SAMPLES_PATH = resolve(
  OUTPUT_DIRECTORY,
  `samples-${SOURCE_RUN_ID}.csv`,
);

const SPLITS_PATH = resolve(
  OUTPUT_DIRECTORY,
  `oos-splits-${SPLIT_RUN_ID}.csv`,
);

const FORECAST_TABLE_PATH = resolve(
  OUTPUT_DIRECTORY,
  `forecast-table-${SPLIT_RUN_ID}.csv`,
);

const PERFORMANCE_PATH = resolve(
  OUTPUT_DIRECTORY,
  `forecast-performance-${SPLIT_RUN_ID}.csv`,
);

const CALIBRATION_PATH = resolve(
  OUTPUT_DIRECTORY,
  `forecast-calibration-${SPLIT_RUN_ID}.csv`,
);

const METADATA_PATH = resolve(
  OUTPUT_DIRECTORY,
  `forecast-metadata-${SPLIT_RUN_ID}.json`,
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

const FORECAST_THRESHOLDS = [
  0,
  0.25,
  0.5,
  0.75,
  1,
  1.5,
  2,
  3,
] as const;

const FORECAST_CALIBRATION_BOUNDARIES = [
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
] as const;

interface SourceColumns {
  market: number;
  receivedAt: number;
  horizonMs: number;
  speed: number;

  absoluteNormalizedSpeed: number;
  relativeAcceleration: number;
  alignedSurprise: number;

  alignedReturnPermille: number;

  mfePermille: number;
  mfeAtMs: number;

  maePermille: number;
  maeAtMs: number;
}

interface MarketSplit {
  splitAt: number;
}

interface ForecastAccumulator {
  horizonMs: number;

  normalizedSpeedBinIndex: number;
  relativeAccelerationBinIndex: number;
  alignedSurpriseBinIndex: number;

  count: number;
  alignedReturnSum: number;
  positiveCount: number;
}

interface ForecastCell {
  horizonMs: number;

  normalizedSpeedBinIndex: number;
  relativeAccelerationBinIndex: number;
  alignedSurpriseBinIndex: number;

  count: number;
  expectedAlignedReturn: number;
  continuationRate: number;
}

interface PerformanceAccumulator {
  horizonMs: number;
  threshold: number;

  signals: number;

  absoluteForecastSum: number;

  strategyReturnSum: number;
  strategyReturnSquaredSum: number;
  positiveStrategyCount: number;

  actualAlignedReturnSum: number;

  absoluteErrorSum: number;
  squaredErrorSum: number;

  strategyMfeSum: number;
  strategyMfeAtSum: number;

  strategyMaeSum: number;
  strategyMaeAtSum: number;
}

interface CalibrationAccumulator {
  horizonMs: number;
  forecastBinIndex: number;

  signals: number;

  forecastSum: number;
  actualAlignedReturnSum: number;

  strategyReturnSum: number;
  positiveStrategyCount: number;

  strategyMfeSum: number;
  strategyMfeAtSum: number;

  strategyMaeSum: number;
  strategyMaeAtSum: number;
}

interface HorizonCoverage {
  testSamples: number;
  forecastableSamples: number;
  unseenCellSamples: number;
}

const FORECAST_TABLE_HEADERS = [
  'horizonMs',
  'normalizedSpeedBin',
  'relativeAccelerationBin',
  'alignedSurpriseBin',
  'trainSamples',
  'expectedAlignedReturnPermille',
  'continuationRate',
] as const;

const PERFORMANCE_HEADERS = [
  'horizonMs',
  'thresholdPermille',
  'signals',
  'coverage',
  'coverageOfAllTestSamples',
  'meanAbsForecastPermille',
  'meanStrategyReturnPermille',
  'stdDevStrategyReturnPermille',
  'positiveStrategyRate',
  'meanActualAlignedReturnPermille',
  'meanAbsoluteErrorPermille',
  'rootMeanSquaredErrorPermille',
  'meanStrategyMfePermille',
  'meanStrategyMfeAtMs',
  'meanStrategyMaePermille',
  'meanStrategyMaeAtMs',
] as const;

const CALIBRATION_HEADERS = [
  'horizonMs',
  'forecastBin',
  'signals',
  'meanForecastPermille',
  'meanActualAlignedReturnPermille',
  'meanStrategyReturnPermille',
  'positiveStrategyRate',
  'meanStrategyMfePermille',
  'meanStrategyMfeAtMs',
  'meanStrategyMaePermille',
  'meanStrategyMaeAtMs',
] as const;

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
      stream.once('finish', resolvePromise);
      stream.once('error', reject);
      stream.end();
    },
  );
};

const createCsvReader = (
  path: string,
) => {
  return createInterface({
    input: createReadStream(
      path,
      { encoding: 'utf8' },
    ),
    crlfDelay: Infinity,
  });
};

const getColumnIndex = (
  headers: readonly string[],
  name: string,
): number => {
  const index = headers.indexOf(name);

  if (index < 0) {
    throw new Error(
      `CSV column not found: ${name}`,
    );
  }

  return index;
};

const getSourceColumns = (
  headerLine: string,
): SourceColumns => {
  const headers =
    parseCsvLine(headerLine);

  return {
    market:
      getColumnIndex(headers, 'market'),

    receivedAt:
      getColumnIndex(headers, 'receivedAt'),

    horizonMs:
      getColumnIndex(headers, 'horizonMs'),

    speed:
      getColumnIndex(headers, 'speed'),

    absoluteNormalizedSpeed:
      getColumnIndex(
        headers,
        'absoluteNormalizedSpeed',
      ),

    relativeAcceleration:
      getColumnIndex(
        headers,
        'relativeAcceleration',
      ),

    alignedSurprise:
      getColumnIndex(
        headers,
        'alignedSurprise',
      ),

    alignedReturnPermille:
      getColumnIndex(
        headers,
        'alignedReturnPermille',
      ),

    mfePermille:
      getColumnIndex(
        headers,
        'mfePermille',
      ),

    mfeAtMs:
      getColumnIndex(
        headers,
        'mfeAtMs',
      ),

    maePermille:
      getColumnIndex(
        headers,
        'maePermille',
      ),

    maeAtMs:
      getColumnIndex(
        headers,
        'maeAtMs',
      ),
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

const getForecastKey = (
  horizonMs: number,
  normalizedSpeedBinIndex: number,
  relativeAccelerationBinIndex: number,
  alignedSurpriseBinIndex: number,
): string => {
  return [
    horizonMs,
    normalizedSpeedBinIndex,
    relativeAccelerationBinIndex,
    alignedSurpriseBinIndex,
  ].join('|');
};

const getPerformanceKey = (
  horizonMs: number,
  threshold: number,
): string =>
  `${horizonMs}|${threshold}`;

const getCalibrationKey = (
  horizonMs: number,
  forecastBinIndex: number,
): string =>
  `${horizonMs}|${forecastBinIndex}`;

const loadSplits = async ():
Promise<Map<string, MarketSplit>> => {
  const reader =
    createCsvReader(SPLITS_PATH);

  const splits =
    new Map<string, MarketSplit>();

  let marketColumn = -1;
  let splitAtColumn = -1;
  let isHeader = true;

  for await (const line of reader) {
    if (isHeader) {
      const headers =
        parseCsvLine(line);

      marketColumn =
        getColumnIndex(
          headers,
          'market',
        );

      splitAtColumn =
        getColumnIndex(
          headers,
          'splitAt',
        );

      isHeader = false;
      continue;
    }

    if (line.length === 0) {
      continue;
    }

    const values =
      parseCsvLine(line);

    const market =
      values[marketColumn];

    const splitAt =
      Number(
        values[splitAtColumn],
      );

    if (
      !market ||
      !Number.isFinite(splitAt)
    ) {
      continue;
    }

    splits.set(
      market,
      { splitAt },
    );
  }

  return splits;
};

const buildForecastTable = async (
  splits: ReadonlyMap<string, MarketSplit>,
): Promise<{
  cells: Map<string, ForecastCell>;
  trainSamples: number;
  purgedTrainSamples: number;
}> => {
  const accumulators =
    new Map<
      string,
      ForecastAccumulator
    >();

  const reader =
    createCsvReader(SAMPLES_PATH);

  let columns: SourceColumns | null =
    null;

  let trainSamples = 0;
  let purgedTrainSamples = 0;

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

    const split =
      splits.get(market);

    if (!split) {
      continue;
    }

    const receivedAt =
      Number(
        values[columns.receivedAt],
      );

    const horizonMs =
      Number(
        values[columns.horizonMs],
      );

    if (
      !Number.isFinite(receivedAt) ||
      !Number.isFinite(horizonMs)
    ) {
      continue;
    }

    if (receivedAt >= split.splitAt) {
      continue;
    }

    if (
      receivedAt + horizonMs >=
      split.splitAt
    ) {
      purgedTrainSamples++;
      continue;
    }

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

    const alignedReturn =
      Number(
        values[
          columns.alignedReturnPermille
        ],
      );

    if (
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
        alignedReturn,
      )
    ) {
      continue;
    }

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
      getForecastKey(
        horizonMs,
        normalizedSpeedBinIndex,
        relativeAccelerationBinIndex,
        alignedSurpriseBinIndex,
      );

    let accumulator =
      accumulators.get(key);

    if (!accumulator) {
      accumulator = {
        horizonMs,

        normalizedSpeedBinIndex,
        relativeAccelerationBinIndex,
        alignedSurpriseBinIndex,

        count: 0,
        alignedReturnSum: 0,
        positiveCount: 0,
      };

      accumulators.set(
        key,
        accumulator,
      );
    }

    accumulator.count++;
    accumulator.alignedReturnSum +=
      alignedReturn;

    accumulator.positiveCount +=
      Number(alignedReturn > 0);

    trainSamples++;
  }

  const cells =
    new Map<string, ForecastCell>();

  for (
    const [key, accumulator]
    of accumulators
  ) {
    cells.set(
      key,
      {
        horizonMs:
          accumulator.horizonMs,

        normalizedSpeedBinIndex:
          accumulator
            .normalizedSpeedBinIndex,

        relativeAccelerationBinIndex:
          accumulator
            .relativeAccelerationBinIndex,

        alignedSurpriseBinIndex:
          accumulator
            .alignedSurpriseBinIndex,

        count:
          accumulator.count,

        expectedAlignedReturn:
          accumulator.alignedReturnSum /
          accumulator.count,

        continuationRate:
          accumulator.positiveCount /
          accumulator.count,
      },
    );
  }

  return {
    cells,
    trainSamples,
    purgedTrainSamples,
  };
};

const writeForecastTable = async (
  cells: ReadonlyMap<string, ForecastCell>,
): Promise<void> => {
  const stream =
    createWriteStream(
      FORECAST_TABLE_PATH,
      { encoding: 'utf8' },
    );

  try {
    await writeToStream(
      stream,
      getCsvLine(
        FORECAST_TABLE_HEADERS,
      ),
    );

    const sortedCells =
      [...cells.values()].sort(
        (a, b) =>
          a.horizonMs - b.horizonMs ||
          a.normalizedSpeedBinIndex -
            b.normalizedSpeedBinIndex ||
          a.relativeAccelerationBinIndex -
            b.relativeAccelerationBinIndex ||
          a.alignedSurpriseBinIndex -
            b.alignedSurpriseBinIndex,
      );

    for (const cell of sortedCells) {
      await writeToStream(
        stream,
        getCsvLine([
          cell.horizonMs,

          getBinName(
            NORMALIZED_SPEED_BOUNDARIES,
            cell.normalizedSpeedBinIndex,
          ),

          getBinName(
            RELATIVE_ACCELERATION_BOUNDARIES,
            cell.relativeAccelerationBinIndex,
          ),

          getBinName(
            ALIGNED_SURPRISE_BOUNDARIES,
            cell.alignedSurpriseBinIndex,
          ),

          cell.count,

          toFiniteString(
            cell.expectedAlignedReturn,
          ),

          toFiniteString(
            cell.continuationRate,
          ),
        ]),
      );
    }
  } finally {
    await closeStream(stream);
  }
};

const createPerformanceAccumulator = (
  horizonMs: number,
  threshold: number,
): PerformanceAccumulator => ({
  horizonMs,
  threshold,

  signals: 0,

  absoluteForecastSum: 0,

  strategyReturnSum: 0,
  strategyReturnSquaredSum: 0,
  positiveStrategyCount: 0,

  actualAlignedReturnSum: 0,

  absoluteErrorSum: 0,
  squaredErrorSum: 0,

  strategyMfeSum: 0,
  strategyMfeAtSum: 0,

  strategyMaeSum: 0,
  strategyMaeAtSum: 0,
});

const createCalibrationAccumulator = (
  horizonMs: number,
  forecastBinIndex: number,
): CalibrationAccumulator => ({
  horizonMs,
  forecastBinIndex,

  signals: 0,

  forecastSum: 0,
  actualAlignedReturnSum: 0,

  strategyReturnSum: 0,
  positiveStrategyCount: 0,

  strategyMfeSum: 0,
  strategyMfeAtSum: 0,

  strategyMaeSum: 0,
  strategyMaeAtSum: 0,
});

const evaluateForecast = async (
  splits: ReadonlyMap<string, MarketSplit>,
  cells: ReadonlyMap<string, ForecastCell>,
): Promise<{
  performance:
    Map<string, PerformanceAccumulator>;

  calibration:
    Map<string, CalibrationAccumulator>;

  coverage:
    Map<number, HorizonCoverage>;

  testSamples: number;
  forecastableSamples: number;
  unseenCellSamples: number;
}> => {
  const performance =
    new Map<
      string,
      PerformanceAccumulator
    >();

  const calibration =
    new Map<
      string,
      CalibrationAccumulator
    >();

  const coverage =
    new Map<number, HorizonCoverage>();

  const reader =
    createCsvReader(SAMPLES_PATH);

  let columns: SourceColumns | null =
    null;

  let testSamples = 0;
  let forecastableSamples = 0;
  let unseenCellSamples = 0;

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

    const split =
      splits.get(market);

    if (!split) {
      continue;
    }

    const receivedAt =
      Number(
        values[columns.receivedAt],
      );

    if (
      !Number.isFinite(receivedAt) ||
      receivedAt < split.splitAt
    ) {
      continue;
    }

    const horizonMs =
      Number(
        values[columns.horizonMs],
      );

    const speed =
      Number(
        values[columns.speed],
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

    const actualAlignedReturn =
      Number(
        values[
          columns.alignedReturnPermille
        ],
      );

    const mfe =
      Number(
        values[columns.mfePermille],
      );

    const mfeAtMs =
      Number(
        values[columns.mfeAtMs],
      );

    const mae =
      Number(
        values[columns.maePermille],
      );

    const maeAtMs =
      Number(
        values[columns.maeAtMs],
      );

    if (
      !Number.isFinite(horizonMs) ||
      !Number.isFinite(speed) ||
      speed === 0 ||
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
        actualAlignedReturn,
      ) ||
      !Number.isFinite(mfe) ||
      !Number.isFinite(mfeAtMs) ||
      !Number.isFinite(mae) ||
      !Number.isFinite(maeAtMs)
    ) {
      continue;
    }

    testSamples++;

    let horizonCoverage =
      coverage.get(horizonMs);

    if (!horizonCoverage) {
      horizonCoverage = {
        testSamples: 0,
        forecastableSamples: 0,
        unseenCellSamples: 0,
      };

      coverage.set(
        horizonMs,
        horizonCoverage,
      );
    }

    horizonCoverage.testSamples++;

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
      getForecastKey(
        horizonMs,
        normalizedSpeedBinIndex,
        relativeAccelerationBinIndex,
        alignedSurpriseBinIndex,
      );

    const cell =
      cells.get(key);

    if (!cell) {
      unseenCellSamples++;
      horizonCoverage.unseenCellSamples++;
      continue;
    }

    forecastableSamples++;
    horizonCoverage.forecastableSamples++;

    const forecast =
      cell.expectedAlignedReturn;

    const absoluteForecast =
      Math.abs(forecast);

    /*
     * The forecast is expressed in coordinates aligned
     * with the current market speed:
     *
     *   forecast > 0 -> continuation
     *   forecast < 0 -> reversal
     */
    const forecastDirection =
      Math.sign(forecast);

    /*
     * A zero forecast has no trading direction.
     * It still participates in calibration, but not
     * in strategy-performance threshold statistics.
     */
    const strategyReturn =
      actualAlignedReturn *
      forecastDirection;

    let strategyMfe = 0;
    let strategyMfeAtMs = 0;
    let strategyMae = 0;
    let strategyMaeAtMs = 0;

    if (forecastDirection > 0) {
      strategyMfe = mfe;
      strategyMfeAtMs = mfeAtMs;

      strategyMae = mae;
      strategyMaeAtMs = maeAtMs;
    } else if (forecastDirection < 0) {
      strategyMfe = -mae;
      strategyMfeAtMs = maeAtMs;

      strategyMae = -mfe;
      strategyMaeAtMs = mfeAtMs;
    }

    const error =
      actualAlignedReturn -
      forecast;

    const calibrationBinIndex =
      getBinIndex(
        forecast,
        FORECAST_CALIBRATION_BOUNDARIES,
      );

    const calibrationKey =
      getCalibrationKey(
        horizonMs,
        calibrationBinIndex,
      );

    let calibrationAccumulator =
      calibration.get(
        calibrationKey,
      );

    if (!calibrationAccumulator) {
      calibrationAccumulator =
        createCalibrationAccumulator(
          horizonMs,
          calibrationBinIndex,
        );

      calibration.set(
        calibrationKey,
        calibrationAccumulator,
      );
    }

    calibrationAccumulator.signals++;
    calibrationAccumulator.forecastSum +=
      forecast;

    calibrationAccumulator
      .actualAlignedReturnSum +=
      actualAlignedReturn;

    if (forecastDirection !== 0) {
      calibrationAccumulator
        .strategyReturnSum +=
        strategyReturn;

      calibrationAccumulator
        .positiveStrategyCount +=
        Number(strategyReturn > 0);

      calibrationAccumulator
        .strategyMfeSum +=
        strategyMfe;

      calibrationAccumulator
        .strategyMfeAtSum +=
        strategyMfeAtMs;

      calibrationAccumulator
        .strategyMaeSum +=
        strategyMae;

      calibrationAccumulator
        .strategyMaeAtSum +=
        strategyMaeAtMs;
    }

    if (forecastDirection === 0) {
      continue;
    }

    for (
      const threshold
      of FORECAST_THRESHOLDS
    ) {
      if (
        absoluteForecast <
        threshold
      ) {
        continue;
      }

      const performanceKey =
        getPerformanceKey(
          horizonMs,
          threshold,
        );

      let accumulator =
        performance.get(
          performanceKey,
        );

      if (!accumulator) {
        accumulator =
          createPerformanceAccumulator(
            horizonMs,
            threshold,
          );

        performance.set(
          performanceKey,
          accumulator,
        );
      }

      accumulator.signals++;

      accumulator.absoluteForecastSum +=
        absoluteForecast;

      accumulator.strategyReturnSum +=
        strategyReturn;

      accumulator.strategyReturnSquaredSum +=
        strategyReturn *
        strategyReturn;

      accumulator.positiveStrategyCount +=
        Number(strategyReturn > 0);

      accumulator.actualAlignedReturnSum +=
        actualAlignedReturn;

      accumulator.absoluteErrorSum +=
        Math.abs(error);

      accumulator.squaredErrorSum +=
        error * error;

      accumulator.strategyMfeSum +=
        strategyMfe;

      accumulator.strategyMfeAtSum +=
        strategyMfeAtMs;

      accumulator.strategyMaeSum +=
        strategyMae;

      accumulator.strategyMaeAtSum +=
        strategyMaeAtMs;
    }
  }

  return {
    performance,
    calibration,
    coverage,

    testSamples,
    forecastableSamples,
    unseenCellSamples,
  };
};

const getStandardDeviation = (
  sum: number,
  squaredSum: number,
  count: number,
): number => {
  if (count < 2) {
    return 0;
  }

  const variance =
    (
      squaredSum -
      sum * sum / count
    ) /
    (count - 1);

  return Math.sqrt(
    Math.max(0, variance),
  );
};

const writePerformance = async (
  accumulators:
    ReadonlyMap<
      string,
      PerformanceAccumulator
    >,
  coverage:
    ReadonlyMap<number, HorizonCoverage>,
): Promise<void> => {
  const stream =
    createWriteStream(
      PERFORMANCE_PATH,
      { encoding: 'utf8' },
    );

  try {
    await writeToStream(
      stream,
      getCsvLine(
        PERFORMANCE_HEADERS,
      ),
    );

    const rows =
      [...accumulators.values()].sort(
        (a, b) =>
          a.horizonMs - b.horizonMs ||
          a.threshold - b.threshold,
      );

    for (const row of rows) {
      const horizonCoverage =
        coverage.get(row.horizonMs);

      if (!horizonCoverage) {
        continue;
      }

      const count =
        row.signals;

      const forecastableCoverage =
        horizonCoverage
          .forecastableSamples > 0
          ? count /
            horizonCoverage
              .forecastableSamples
          : 0;

      const allTestCoverage =
        horizonCoverage.testSamples > 0
          ? count /
            horizonCoverage.testSamples
          : 0;

      await writeToStream(
        stream,
        getCsvLine([
          row.horizonMs,
          row.threshold,
          count,

          toFiniteString(
            forecastableCoverage,
          ),

          toFiniteString(
            allTestCoverage,
          ),

          toFiniteString(
            row.absoluteForecastSum /
            count,
          ),

          toFiniteString(
            row.strategyReturnSum /
            count,
          ),

          toFiniteString(
            getStandardDeviation(
              row.strategyReturnSum,
              row.strategyReturnSquaredSum,
              count,
            ),
          ),

          toFiniteString(
            row.positiveStrategyCount /
            count,
          ),

          toFiniteString(
            row.actualAlignedReturnSum /
            count,
          ),

          toFiniteString(
            row.absoluteErrorSum /
            count,
          ),

          toFiniteString(
            Math.sqrt(
              row.squaredErrorSum /
              count,
            ),
          ),

          toFiniteString(
            row.strategyMfeSum /
            count,
          ),

          toFiniteString(
            row.strategyMfeAtSum /
            count,
          ),

          toFiniteString(
            row.strategyMaeSum /
            count,
          ),

          toFiniteString(
            row.strategyMaeAtSum /
            count,
          ),
        ]),
      );
    }
  } finally {
    await closeStream(stream);
  }
};

const writeCalibration = async (
  accumulators:
    ReadonlyMap<
      string,
      CalibrationAccumulator
    >,
): Promise<void> => {
  const stream =
    createWriteStream(
      CALIBRATION_PATH,
      { encoding: 'utf8' },
    );

  try {
    await writeToStream(
      stream,
      getCsvLine(
        CALIBRATION_HEADERS,
      ),
    );

    const rows =
      [...accumulators.values()].sort(
        (a, b) =>
          a.horizonMs - b.horizonMs ||
          a.forecastBinIndex -
            b.forecastBinIndex,
      );

    for (const row of rows) {
      const count =
        row.signals;

      await writeToStream(
        stream,
        getCsvLine([
          row.horizonMs,

          getBinName(
            FORECAST_CALIBRATION_BOUNDARIES,
            row.forecastBinIndex,
          ),

          count,

          toFiniteString(
            row.forecastSum /
            count,
          ),

          toFiniteString(
            row.actualAlignedReturnSum /
            count,
          ),

          toFiniteString(
            row.strategyReturnSum /
            count,
          ),

          toFiniteString(
            row.positiveStrategyCount /
            count,
          ),

          toFiniteString(
            row.strategyMfeSum /
            count,
          ),

          toFiniteString(
            row.strategyMfeAtSum /
            count,
          ),

          toFiniteString(
            row.strategyMaeSum /
            count,
          ),

          toFiniteString(
            row.strategyMaeAtSum /
            count,
          ),
        ]),
      );
    }
  } finally {
    await closeStream(stream);
  }
};

const main = async (): Promise<void> => {
  const startTime = Date.now();

  await mkdir(
    OUTPUT_DIRECTORY,
    { recursive: true },
  );

  console.log(
    `Samples: ${SAMPLES_PATH}`,
  );

  console.log(
    `Splits: ${SPLITS_PATH}`,
  );

  console.log('');
  console.log(
    'Loading chronological splits...',
  );

  const splits =
    await loadSplits();

  console.log(
    `Loaded ${splits.size} market splits.`,
  );

  console.log('');
  console.log(
    'Pass 1/2: building train forecast table...',
  );

  const {
    cells,
    trainSamples,
    purgedTrainSamples,
  } = await buildForecastTable(
    splits,
  );

  console.log(
    `Train samples: ${trainSamples}`,
  );

  console.log(
    `Purged train samples: ` +
    `${purgedTrainSamples}`,
  );

  console.log(
    `Forecast cells: ${cells.size}`,
  );

  await writeForecastTable(cells);

  console.log('');
  console.log(
    'Pass 2/2: evaluating frozen forecast on test...',
  );

  const evaluation =
    await evaluateForecast(
      splits,
      cells,
    );

  await writePerformance(
    evaluation.performance,
    evaluation.coverage,
  );

  await writeCalibration(
    evaluation.calibration,
  );

  const elapsedMinutes =
    (
      (Date.now() - startTime) /
      60_000
    ).toFixed(1);

  const coverageByHorizon =
    [...evaluation.coverage.entries()]
      .sort(
        ([a], [b]) => a - b,
      )
      .map(
        ([horizonMs, value]) => ({
          horizonMs,

          testSamples:
            value.testSamples,

          forecastableSamples:
            value.forecastableSamples,

          unseenCellSamples:
            value.unseenCellSamples,

          forecastableRate:
            value.testSamples > 0
              ? value.forecastableSamples /
                value.testSamples
              : 0,
        }),
      );

  await writeFile(
    METADATA_PATH,
    JSON.stringify(
      {
        generatedAt:
          new Date().toISOString(),

        sourceRunId:
          SOURCE_RUN_ID,

        splitRunId:
          SPLIT_RUN_ID,

        samplesPath:
          SAMPLES_PATH,

        splitsPath:
          SPLITS_PATH,

        normalizedSpeedBoundaries:
          NORMALIZED_SPEED_BOUNDARIES,

        relativeAccelerationBoundaries:
          RELATIVE_ACCELERATION_BOUNDARIES,

        alignedSurpriseBoundaries:
          ALIGNED_SURPRISE_BOUNDARIES,

        forecastThresholds:
          FORECAST_THRESHOLDS,

        forecastCalibrationBoundaries:
          FORECAST_CALIBRATION_BOUNDARIES,

        markets:
          splits.size,

        trainSamples,
        purgedTrainSamples,

        forecastCells:
          cells.size,

        testSamples:
          evaluation.testSamples,

        forecastableSamples:
          evaluation.forecastableSamples,

        unseenCellSamples:
          evaluation.unseenCellSamples,

        forecastableRate:
          evaluation.testSamples > 0
            ? evaluation
                .forecastableSamples /
              evaluation.testSamples
            : 0,

        coverageByHorizon,

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
    `Test samples: ` +
    `${evaluation.testSamples}`,
  );

  console.log(
    `Forecastable samples: ` +
    `${evaluation.forecastableSamples}`,
  );

  console.log(
    `Unseen-cell samples: ` +
    `${evaluation.unseenCellSamples}`,
  );

  console.log(
    `Forecastable rate: ` +
    (
      100 *
      evaluation.forecastableSamples /
      evaluation.testSamples
    ).toFixed(2) +
    '%',
  );

  console.log(
    `Total time: ${elapsedMinutes} minutes`,
  );

  console.log('');
  console.log(
    `Forecast table: ${FORECAST_TABLE_PATH}`,
  );

  console.log(
    `Performance: ${PERFORMANCE_PATH}`,
  );

  console.log(
    `Calibration: ${CALIBRATION_PATH}`,
  );

  console.log(
    `Metadata: ${METADATA_PATH}`,
  );
};

await main();
