// app/src/server/research/market-forecast-comparison-analysis-v6-holdout.ts
// Read-only, frozen v6 base-fit / meta-fit and future-only holdout.
// Run from app with node --import tsx; append --self-test for offline tests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SELF_TEST = process.argv.includes('--self-test');
const RESEARCH_CACHE_PATH = resolve(
  'research-output/market-research-cache/' +
  'market-research-cache_endedAt-2026-10-01_01-21-42Z.sqlite',
);
const BASE_CURRENCY = 'USDT';
const PRICE_EMA_TAU_MS = 7_000;
const PRICE_EMA_WARMUP_MS = 50_000;
const DATA_END_ISO: string | null = null;
const SPLIT_AT_ISO: string | null = '2026-09-27T13:32:50.816Z';
// The original v6 read its test ticks before this exclusive end timestamp.
const TEST_START_ISO: string | null = '2026-09-29T15:05:00.815Z';
const TEST_END_ISO: string | null = null;
const EXPECTED_FIRST_SPOT_TICK = 1790188384582;
const EXPECTED_BASE_FIT_END = '2026-09-26T10:14:54.946Z';
const EXPECTED_TABLE_HASHES = {
  'speed-bank':
    '8c67b24d7b43ef9ad69e359824a93ca6002639c6e546a4e3b11819295af6c9e7',
  'speed-bank-derived':
    'cbcaa1b26d1626c925347efac9be998ab53298b73a0feeab3afa6f447244633a',
  combined:
    'aa7999123095c3e4a020a8fa0b64d6188fac250ae33825b68965dd3314162211',
};
const MARKET_NAMES: string[] = [];
const TRAIN_FRACTION = 0.7;
const BASE_FIT_FRACTION = 0.7;
const HORIZON = 60_000;
const MAX_TARGET_DELAY = 10_000;
const TEST_BLOCK_MS = 6 * 60 * 60_000;
const META_MIN_SAMPLES = 30;
const META_MIN_SPACED = 10;
const MIN_TRAIN_SAMPLES = integer('MF_MIN_TRAIN_SAMPLES', 30, 1, 1_000_000);
const QUALITY_MIN_SAMPLES = 100;
const QUALITY_BLOCKS = 3;
const QUALITY_MIN_BLOCK_SAMPLES = 30;
const OUTPUT = resolve('research-output/market-forecast-comparison-v6-holdout');
const ENTRY_THRESHOLDS = [1, 1.25, 1.5, 1.75, 1.9, 2, 2.25, 2.5, 3];
const ENTRY_BANDS = [
  [1, 1.25], [1.25, 1.5], [1.5, 1.75], [1.75, 1.9], [1.9, 2],
  [2, 2.25], [2.25, 2.5], [2.5, 3], [3, null],
] as const;
const CALIBRATION_THRESHOLDS = [0, ...ENTRY_THRESHOLDS, 4];
const FORECAST_BINS = [-4, -3, -2.5, -2, -1.5, -1, -0.5, 0,
  0.5, 1, 1.5, 2, 2.5, 3, 4];
const SPEED_BANK_TAUS_MS = [7_000, 15_000, 30_000] as const;
const DERIVED_SPEED_BANK_TAUS_MS = [7_000, 15_000, 30_000, 60_000] as const;
const SPEED_BANK_WARMUP_MS = 150_000;
const DERIVED_SPEED_BANK_WARMUP_MS = 300_000;
const ALIGNED_SPEED_BINS = [
  -3, -1, -0.3, 0, 0.1, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5,
];
const SLOW_SPEED_BINS = [
  0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8,
];
const SCALE_CURVATURE_BINS = [
  -8, -4, -2, -1, -0.5, -0.2, 0, 0.2, 0.5, 1, 2, 4, 8,
];
const SPEED_BANK_STATE_COUNT = (ALIGNED_SPEED_BINS.length + 1) ** 2 *
  (SLOW_SPEED_BINS.length + 1);
const DERIVED_SPEED_BANK_STATE_COUNT = (ALIGNED_SPEED_BINS.length + 1) *
  (SCALE_CURVATURE_BINS.length + 1) * (SLOW_SPEED_BINS.length + 1);
let ACTIVE_STATE_COUNT = SPEED_BANK_STATE_COUNT;
type ModelId = 'speed-bank' | 'speed-bank-derived' | 'combined';
type BaseModelId = Exclude<ModelId, 'combined'>;
type ModelConfig = { id: BaseModelId; stateCount: number };
const MODELS: readonly ModelConfig[] = [
  { id: 'speed-bank', stateCount: SPEED_BANK_STATE_COUNT },
  { id: 'speed-bank-derived', stateCount: DERIVED_SPEED_BANK_STATE_COUNT },
];
const EVAL_MODELS: readonly ModelId[] = [
  'speed-bank', 'speed-bank-derived', 'combined',
];
type Market = { id: number; name: string; stock: string; money: string };
type Row = { t: number; p: number; cell: number; sign: number; e?: number | null };
function integer(name: string, fallback: number, min: number, max: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name}: expected integer in [${min}, ${max}]`);
  }
  return n;
}
function dateSetting(value: string | null, name: string): number | null {
  if (!value) return null;
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new Error(`${name}: use ISO datetime with explicit timezone`);
  }
  const t = Date.parse(value);
  if (!Number.isSafeInteger(t)) throw new Error(`Invalid ${name}`);
  return t;
}
const DATA_END = dateSetting(DATA_END_ISO, 'DATA_END_ISO');
const REQUESTED_SPLIT = SELF_TEST ? null :
  dateSetting(SPLIT_AT_ISO, 'SPLIT_AT_ISO');
const REQUESTED_START = SELF_TEST ? null :
  dateSetting(TEST_START_ISO, 'TEST_START_ISO');
const REQUESTED_END = dateSetting(TEST_END_ISO, 'TEST_END_ISO');
function targetDefinition() { return {
  kind: 'ema-residual-over-constant-price', tauMs: PRICE_EMA_TAU_MS,
  warmupMs: PRICE_EMA_WARMUP_MS,
  formula: '1000 * ln(EMA(target) / Eflat(target-origin))',
  control: 'Eflat(dt)=price(origin)+(EMA(origin)-price(origin))*exp(-dt/tau)',
  targetTime: 'first tick >= origin+60s, at most 10s late',
}; }
function bin(value: number, boundaries: readonly number[]) {
  const index = boundaries.findIndex((boundary) => value < boundary);
  return index < 0 ? boundaries.length : index;
}

function speedBankCell(speeds: readonly number[]): { cell: number; sign: number } {
  if (speeds.length !== SPEED_BANK_TAUS_MS.length ||
    !speeds.every(Number.isFinite)) return { cell: -1, sign: 0 };
  const slow = speeds[speeds.length - 1];
  if (slow === 0) return { cell: -1, sign: 0 };
  const sign = Math.sign(slow);
  const fast = speeds[0] * sign;
  const medium = speeds[1] * sign;
  const slowAbs = Math.abs(slow);
  const cell = (bin(fast, ALIGNED_SPEED_BINS) *
    (ALIGNED_SPEED_BINS.length + 1) + bin(medium, ALIGNED_SPEED_BINS)) *
    (SLOW_SPEED_BINS.length + 1) + bin(slowAbs, SLOW_SPEED_BINS);
  return { cell, sign };
}

type DerivedSpeedBankState = {
  cell: number;
  sign: number;
  level: number;
  contrast: number;
  curvature: number;
};

function derivedSpeedBankCell(speeds: readonly number[]): DerivedSpeedBankState {
  if (speeds.length !== DERIVED_SPEED_BANK_TAUS_MS.length ||
    !speeds.every(Number.isFinite)) {
    return { cell: -1, sign: 0, level: NaN, contrast: NaN, curvature: NaN };
  }
  const [v7, v15, v30, v60] = speeds;
  if (v60 === 0) {
    return { cell: -1, sign: 0, level: NaN, contrast: NaN, curvature: NaN };
  }
  const sign = Math.sign(v60);
  const level = Math.abs(v60);
  const contrast = (v7 - v30) * sign;
  const shortScaleSlope = (v7 - v15) / ((15 - 7) / 60);
  const longScaleSlope = (v30 - v60) / ((60 - 30) / 60);
  const curvature = (shortScaleSlope - longScaleSlope) * sign;
  if (![level, contrast, curvature].every(Number.isFinite)) {
    return { cell: -1, sign: 0, level, contrast, curvature };
  }
  const cell = (bin(contrast, ALIGNED_SPEED_BINS) *
    (SCALE_CURVATURE_BINS.length + 1) + bin(curvature, SCALE_CURVATURE_BINS)) *
    (SLOW_SPEED_BINS.length + 1) + bin(level, SLOW_SPEED_BINS);
  return { cell, sign, level, contrast, curvature };
}

type SpeedBanksState = {
  direct: { cell: number; sign: number } | null;
  derived: DerivedSpeedBankState | null;
};

class SpeedBanks {
  private readonly ema = new Float64Array(DERIVED_SPEED_BANK_TAUS_MS.length);
  private previous = NaN;
  private first = NaN;

  update(t: number, price: number): SpeedBanksState {
    const x = 1000 * Math.log(price);
    if (!Number.isFinite(this.previous)) {
      this.ema.fill(x);
      this.first = t;
    } else {
      if (t <= this.previous) throw new Error('Speed banks need increasing timestamps');
      const dt = t - this.previous;
      for (let i = 0; i < DERIVED_SPEED_BANK_TAUS_MS.length; i++) {
        const alpha = -Math.expm1(-dt / DERIVED_SPEED_BANK_TAUS_MS[i]);
        this.ema[i] += alpha * (x - this.ema[i]);
      }
    }
    this.previous = t;
    const speeds = DERIVED_SPEED_BANK_TAUS_MS.map((tau, i) =>
      (x - this.ema[i]) / (tau / 60_000));
    return {
      direct: t - this.first < SPEED_BANK_WARMUP_MS
        ? null
        : speedBankCell(speeds.slice(0, SPEED_BANK_TAUS_MS.length)),
      derived: t - this.first < DERIVED_SPEED_BANK_WARMUP_MS
        ? null
        : derivedSpeedBankCell(speeds),
    };
  }
}

type ExtractionStats = { ready: number; warmup: number; invalid: number };
type SpeedBankExtractionStats = {
  direct: ExtractionStats;
  derived: ExtractionStats;
};

type DerivedDistribution = {
  level: number[];
  contrast: number[];
  curvature: number[];
};

function newDerivedDistribution(): DerivedDistribution {
  return {
    level: Array(SLOW_SPEED_BINS.length + 1).fill(0),
    contrast: Array(ALIGNED_SPEED_BINS.length + 1).fill(0),
    curvature: Array(SCALE_CURVATURE_BINS.length + 1).fill(0),
  };
}

function observeDerivedDistribution(distribution: DerivedDistribution,
  state: DerivedSpeedBankState) {
  distribution.level[bin(state.level, SLOW_SPEED_BINS)]++;
  distribution.contrast[bin(state.contrast, ALIGNED_SPEED_BINS)]++;
  distribution.curvature[bin(state.curvature, SCALE_CURVATURE_BINS)]++;
}

function updateStats(stats: ExtractionStats,
  state: { cell: number } | null) {
  if (state === null) stats.warmup++;
  else if (state.cell < 0) stats.invalid++;
  else stats.ready++;
}

async function writeDerivedFeatureDistribution(path: string,
  distribution: DerivedDistribution) {
  const csv = await Csv.create(path, [
    'feature', 'binIndex', 'minInclusive', 'maxExclusive', 'trainOriginSamples',
  ]);
  const write = async (feature: string, boundaries: readonly number[],
    counts: readonly number[]) => {
    for (let i = 0; i < counts.length; i++) {
      await csv.row([
        feature,
        i,
        i === 0 ? null : boundaries[i - 1],
        i === boundaries.length ? null : boundaries[i],
        counts[i],
      ]);
    }
  };
  try {
    await write('levelAbsV60', SLOW_SPEED_BINS, distribution.level);
    await write('alignedV7MinusV30', ALIGNED_SPEED_BINS, distribution.contrast);
    await write('alignedScaleCurvature', SCALE_CURVATURE_BINS,
      distribution.curvature);
  } finally {
    await csv.close();
  }
}

// One state and one bounded page per market over deduplicated cached observations.
class PriceEma {
  private value = NaN;
  private previous = NaN;
  private first = NaN;
  update(t: number, price: number): number | null {
    if (!Number.isFinite(this.previous)) {
      this.value = price;
      this.first = t;
    } else {
      if (t <= this.previous) throw new Error('EMA needs increasing timestamps');
      const alpha = -Math.expm1(-(t - this.previous) / PRICE_EMA_TAU_MS);
      this.value += alpha * (price - this.value);
    }
    this.previous = t;
    return t - this.first >= PRICE_EMA_WARMUP_MS ? this.value : null;
  }
}

class Csv {
  private readonly file: FileHandle;
  constructor(file: FileHandle) { this.file = file; }
  static async create(path: string, headers: string[]) {
    const csv = new Csv(await open(path, 'wx'));
    await csv.row(headers);
    return csv;
  }
  async row(values: unknown[]) {
    const line = values.map((v) => {
      if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
      return `"${String(v).replaceAll('"', '""')}"`;
    }).join(',') + '\n';
    // Await every write; do not accumulate pending promises or output rows.
    await this.file.writeFile(line);
  }
  async close() { await this.file.close(); }
}
function newCells() {
  return { count: new Float64Array(ACTIVE_STATE_COUNT),
    mean: new Float64Array(ACTIVE_STATE_COUNT), m2: new Float64Array(ACTIVE_STATE_COUNT) };
}

// Fixed-size accumulators: no per-tick history and no market x cell matrix.
function accumulate(c: ReturnType<typeof newCells>, cell: number, value: number) {
  const n = ++c.count[cell];
  const delta = value - c.mean[cell];
  c.mean[cell] += delta / n;
  c.m2[cell] += delta * (value - c.mean[cell]);
}
class CellQuality {
  readonly blocks = Array.from({ length: QUALITY_BLOCKS }, newCells);
  readonly spaced = newCells();
  readonly marketCount = new Uint32Array(ACTIVE_STATE_COUNT);
  readonly largestMarketCount = new Float64Array(ACTIVE_STATE_COUNT);
  readonly largestMarket = new Array<string>(ACTIVE_STATE_COUNT).fill('');
  readonly positive = new Float64Array(ACTIVE_STATE_COUNT);
  readonly min = new Float64Array(ACTIVE_STATE_COUNT).fill(Infinity);
  readonly max = new Float64Array(ACTIVE_STATE_COUNT).fill(-Infinity);
  readonly boundaryCrossings = new Float64Array(ACTIVE_STATE_COUNT);
  private marketSamples = new Float64Array(ACTIVE_STATE_COUNT);
  private lastTarget = new Float64Array(ACTIVE_STATE_COUNT).fill(-Infinity);
  readonly first: number;
  readonly split: number;
  constructor(first: number, split: number) {
    this.first = first; this.split = split;
  }
  beginMarket() {
    this.marketSamples.fill(0);
    this.lastTarget.fill(-Infinity);
  }
  observe(a: Row, b: Row, value: number) {
    const cell = a.cell;
    assert.ok(a.t >= this.first && b.t < this.split);
    this.marketSamples[cell]++;
    this.positive[cell] += Number(value > 0);
    this.min[cell] = Math.min(this.min[cell], value);
    this.max[cell] = Math.max(this.max[cell], value);
    const block = Math.min(QUALITY_BLOCKS - 1, Math.floor(
      QUALITY_BLOCKS * (a.t - this.first) / (this.split - this.first)));
    const blockEnd = this.first + (block + 1) *
      (this.split - this.first) / QUALITY_BLOCKS;
    // Purge labels that extend into a later block, not just the final test.
    if (b.t < blockEnd) accumulate(this.blocks[block], cell, value);
    else this.boundaryCrossings[cell]++;
    // Actual target times define overlap; process each market chronologically.
    if (a.t >= this.lastTarget[cell]) {
      accumulate(this.spaced, cell, value);
      this.lastTarget[cell] = b.t;
    }
  }
  endMarket(name: string) {
    for (let i = 0; i < ACTIVE_STATE_COUNT; i++) {
      const n = this.marketSamples[i];
      if (n) this.marketCount[i]++;
      if (n > this.largestMarketCount[i]) {
        this.largestMarketCount[i] = n;
        this.largestMarket[i] = name;
      }
    }
  }
  flags(cell: number, cells: ReturnType<typeof newCells>) {
    const flags: string[] = [];
    const n = cells.count[cell];
    if (n < QUALITY_MIN_SAMPLES) flags.push('few-samples');
    if (this.blocks.some((b) => b.count[cell] < QUALITY_MIN_BLOCK_SAMPLES)) {
      flags.push('sparse-time-blocks');
    }
    const populated = this.blocks.filter((b) => b.count[cell] >= QUALITY_MIN_BLOCK_SAMPLES);
    if (populated.some((b) => Math.sign(b.mean[cell]) !== Math.sign(cells.mean[cell]))) {
      flags.push('block-sign-disagreement');
    }
    if (n && this.largestMarketCount[cell] / n > 0.5) flags.push('market-concentration');
    return flags.join('|') || 'no-listed-flags';
  }
}
type SoftReliability = {
  table: Float64Array;
  factor: Float64Array;
  standardError: Float64Array;
  effectiveSamples: Float64Array;
  pooledVariance: number;
  priorVariance: number;
  meanSamplingVariance: number;
  estimatedCells: number;
};

function buildSoftReliability(cells: ReturnType<typeof newCells>,
  quality: CellQuality): SoftReliability {
  let pooledM2 = 0;
  let pooledDf = 0;
  for (let cell = 0; cell < ACTIVE_STATE_COUNT; cell++) {
    const n = quality.spaced.count[cell];
    if (n > 1) {
      pooledM2 += quality.spaced.m2[cell];
      pooledDf += n - 1;
    }
  }
  const pooledVariance = pooledDf ? pooledM2 / pooledDf : 1;
  let secondMoment = 0;
  let samplingVariance = 0;
  let estimatedCells = 0;
  for (let cell = 0; cell < ACTIVE_STATE_COUNT; cell++) {
    const n = quality.spaced.count[cell];
    if (cells.count[cell] < MIN_TRAIN_SAMPLES || n < 2) continue;
    const localVariance = quality.spaced.m2[cell] / (n - 1);
    const se2 = (Number.isFinite(localVariance) ? localVariance : pooledVariance) / n;
    secondMoment += cells.mean[cell] ** 2;
    samplingVariance += se2;
    estimatedCells++;
  }
  const meanSamplingVariance = estimatedCells ? samplingVariance / estimatedCells : 0;
  const observedSecondMoment = estimatedCells ? secondMoment / estimatedCells : 0;
  // Zero is the conservative prior forecast. The prior variance is estimated
  // only from chronological training cells and never from the test period.
  const priorVariance = Math.max(1e-6, observedSecondMoment - meanSamplingVariance);
  const table = new Float64Array(ACTIVE_STATE_COUNT).fill(NaN);
  const factor = new Float64Array(ACTIVE_STATE_COUNT);
  const standardError = new Float64Array(ACTIVE_STATE_COUNT).fill(NaN);
  const effectiveSamples = Float64Array.from(quality.spaced.count);
  for (let cell = 0; cell < ACTIVE_STATE_COUNT; cell++) {
    if (cells.count[cell] < MIN_TRAIN_SAMPLES) continue;
    const n = quality.spaced.count[cell];
    if (!n) continue;
    const localVariance = n > 1 ? quality.spaced.m2[cell] / (n - 1) : pooledVariance;
    const variance = Number.isFinite(localVariance) ? localVariance : pooledVariance;
    const se2 = Math.max(0, variance) / n;
    const reliability = priorVariance / (priorVariance + se2);
    factor[cell] = reliability;
    standardError[cell] = Math.sqrt(se2);
    table[cell] = cells.mean[cell] * reliability;
  }
  return { table, factor, standardError, effectiveSamples, pooledVariance,
    priorVariance, meanSamplingVariance, estimatedCells };
}

async function writeQuality(quality: CellQuality, cells: ReturnType<typeof newCells>,
  reliability: SoftReliability, csv: Csv, blocks: Csv) {
  for (let cell = 0; cell < ACTIVE_STATE_COUNT; cell++) {
    const n = cells.count[cell];
    if (!n) continue;
    const ns = quality.spaced.count[cell];
    const sd = n > 1 ? Math.sqrt(cells.m2[cell] / (n - 1)) : null;
    await csv.row([cell, Number.isFinite(reliability.table[cell]), n,
      cells.mean[cell], reliability.table[cell], reliability.factor[cell],
      reliability.effectiveSamples[cell], reliability.standardError[cell], sd,
      quality.min[cell], quality.max[cell], quality.positive[cell] / n,
      quality.marketCount[cell], quality.largestMarket[cell],
      quality.largestMarketCount[cell] / n, ns,
      ns ? quality.spaced.mean[cell] : null,
      ns > 1 ? Math.sqrt(quality.spaced.m2[cell] / (ns - 1)) : null,
      quality.boundaryCrossings[cell], quality.flags(cell, cells)]);
    for (const [index, b] of quality.blocks.entries()) {
      const bn = b.count[cell];
      await blocks.row([cell, index + 1,
        quality.first + index * (quality.split - quality.first) / QUALITY_BLOCKS,
        quality.first + (index + 1) * (quality.split - quality.first) / QUALITY_BLOCKS,
        bn, bn ? b.mean[cell] : null,
        bn > 1 ? Math.sqrt(b.m2[cell] / (bn - 1)) : null,
        bn >= QUALITY_MIN_BLOCK_SAMPLES]);
    }
  }
}
const COMMON_COMPARE_THRESHOLDS = ENTRY_THRESHOLDS;

type PairAggregate = {
  count: number;
  leftForecast: number;
  rightForecast: number;
  residual: number;
  residualSquared: number;
  raw: number;
  leftDirectional: number;
  rightDirectional: number;
  leftRawDirectional: number;
  rightRawDirectional: number;
  leftCorrect: number;
  rightCorrect: number;
  leftRawCorrect: number;
  rightRawCorrect: number;
  leftAbsError: number;
  rightAbsError: number;
  leftSquaredError: number;
  rightSquaredError: number;
};

function newPairAggregate(): PairAggregate {
  return {
    count: 0,
    leftForecast: 0,
    rightForecast: 0,
    residual: 0,
    residualSquared: 0,
    raw: 0,
    leftDirectional: 0,
    rightDirectional: 0,
    leftRawDirectional: 0,
    rightRawDirectional: 0,
    leftCorrect: 0,
    rightCorrect: 0,
    leftRawCorrect: 0,
    rightRawCorrect: 0,
    leftAbsError: 0,
    rightAbsError: 0,
    leftSquaredError: 0,
    rightSquaredError: 0,
  };
}

function observePair(g: PairAggregate, left: number, right: number,
  residual: number, raw: number) {
  g.count++;
  g.leftForecast += left;
  g.rightForecast += right;
  g.residual += residual;
  g.residualSquared += residual ** 2;
  g.raw += raw;
  g.leftDirectional += residual * Math.sign(left);
  g.rightDirectional += residual * Math.sign(right);
  g.leftRawDirectional += raw * Math.sign(left);
  g.rightRawDirectional += raw * Math.sign(right);
  g.leftCorrect += Number(residual * left > 0);
  g.rightCorrect += Number(residual * right > 0);
  g.leftRawCorrect += Number(raw * left > 0);
  g.rightRawCorrect += Number(raw * right > 0);
  g.leftAbsError += Math.abs(left - residual);
  g.rightAbsError += Math.abs(right - residual);
  g.leftSquaredError += (left - residual) ** 2;
  g.rightSquaredError += (right - residual) ** 2;
}

function pairCohorts(left: number, right: number,
  leftId: ModelId, rightId: ModelId) {
  const result = ['all-common'];
  for (const threshold of COMMON_COMPARE_THRESHOLDS) {
    const l = Math.abs(left) >= threshold;
    const r = Math.abs(right) >= threshold;
    if (l && r) {
      result.push(`both>=${threshold}`);
      result.push(Math.sign(left) === Math.sign(right)
        ? `both>=${threshold}-same-sign`
        : `both>=${threshold}-opposite-sign`);
    } else if (l) {
      result.push(`${leftId}-only>=${threshold}`);
    } else if (r) {
      result.push(`${rightId}-only>=${threshold}`);
    }
  }
  return result;
}

function modelFrozenMetadata(model: ModelConfig) {
  if (model.id === 'speed-bank') return {
    featureModel: 'causal-multiscale-speed-bank-direct',
    speedBankTausMs: SPEED_BANK_TAUS_MS,
    speedBankWarmupMs: SPEED_BANK_WARMUP_MS,
    formula: 'v_tau=(1000*ln(price)-EMA_tau(1000*ln(price)))/(tau/60000)',
    coordinate: 'v7 and v15 aligned to sign(v30); level=abs(v30)',
    bins: { alignedFast: ALIGNED_SPEED_BINS, alignedMedium: ALIGNED_SPEED_BINS,
      slowAbs: SLOW_SPEED_BINS },
    layout: '(alignedFastIndex * alignedMediumCount + alignedMediumIndex) * slowAbsCount + slowAbsIndex',
  };
  return {
    featureModel: 'causal-multiscale-speed-bank-derived',
    speedBankTausMs: DERIVED_SPEED_BANK_TAUS_MS,
    speedBankWarmupMs: DERIVED_SPEED_BANK_WARMUP_MS,
    formula: 'v_tau=(1000*ln(price)-EMA_tau(1000*ln(price)))/(tau/60000)',
    coordinate: 'aligned to sign(v60): level=abs(v60), contrast=v7-v30, curvature=d(v7,v15)/dTau-d(v30,v60)/dTau',
    curvatureUnits: 'permille/min^2; tau differences converted from seconds to minutes',
    bins: { levelAbsV60: SLOW_SPEED_BINS, alignedV7MinusV30: ALIGNED_SPEED_BINS,
      alignedScaleCurvature: SCALE_CURVATURE_BINS },
    layout: '(contrastIndex * curvatureCount + curvatureIndex) * levelCount + levelIndex',
  };
}

type Tick = { t: number; p: number };
type Origin = {
  t: number; p: number; e: number | null;
  direct: { cell: number; sign: number } | null;
  derived: DerivedSpeedBankState | null;
  forecasts?: [number, number, number];
  calibrationGroups?: { group: Calibration; basis: 'ema-residual' | 'raw';
    forecast: number }[];
};
type TrainCounts = {
  origins: number; invalidFeature: number; purged: number;
  noTarget: number; lateTarget: number; emaUnavailable: number;
  accepted: number; firstOrigin: number; lastOrigin: number;
  firstTarget: number; lastTarget: number;
};
function newTrainCounts(): TrainCounts { return {
  origins: 0, invalidFeature: 0, purged: 0, noTarget: 0,
  lateTarget: 0, emaUnavailable: 0, accepted: 0,
  firstOrigin: Infinity, lastOrigin: -Infinity,
  firstTarget: Infinity, lastTarget: -Infinity,
}; }
type Trained = {
  model: ModelConfig;
  cells: ReturnType<typeof newCells>;
  quality: CellQuality;
  table?: SoftReliability;
  train: Map<string, TrainCounts>;
};
function stateOf(origin: Origin, id: BaseModelId) {
  return id === 'speed-bank' ? origin.direct : origin.derived;
}
function constantPriceEma(p: number, e: number, dt: number) {
  return p + (e - p) * Math.exp(-dt / PRICE_EMA_TAU_MS);
}
function labelReturns(origin: Origin, tick: Tick, e: number) {
  return {
    residual: 1000 * Math.log(e /
      constantPriceEma(origin.p, origin.e!, tick.t - origin.t)),
    raw: 1000 * Math.log(tick.p / origin.p),
  };
}
function* readTicks(db: DatabaseSync, market: number,
  first: number, end: number): Generator<Tick> {
  const query = db.prepare(`SELECT received_at AS t, price AS p
    FROM observations WHERE market_id=? AND received_at>=?
    AND received_at<? ORDER BY received_at`);
  for (const raw of query.iterate(market, first, end)) yield raw as Tick;
}
function resolveTrain(origin: Origin, tick: Tick, e: number | null,
  trained: readonly Trained[], splitAt: number, marketName: string) {
  for (const model of trained) {
    const state = stateOf(origin, model.model.id);
    if (state === null || state.cell < 0 ||
      origin.t + HORIZON >= splitAt) continue;
    const counts = model.train.get(marketName)!;
    if (tick.t >= splitAt) { counts.purged++; continue; }
    if (tick.t - origin.t - HORIZON > MAX_TARGET_DELAY) {
      counts.lateTarget++; continue;
    }
    if (origin.e === null || e === null) {
      counts.emaUnavailable++; continue;
    }
    const value = state.sign * labelReturns(origin, tick, e).residual;
    accumulate(model.cells, state.cell, value);
    model.quality.observe({ ...origin, ...state },
      { t: tick.t, p: tick.p, cell: 0, sign: 0, e }, value);
    counts.accepted++;
    counts.firstOrigin = Math.min(counts.firstOrigin, origin.t);
    counts.lastOrigin = Math.max(counts.lastOrigin, origin.t);
    counts.firstTarget = Math.min(counts.firstTarget, tick.t);
    counts.lastTarget = Math.max(counts.lastTarget, tick.t);
  }
}
function trainMarket(db: DatabaseSync, market: Market, trained: readonly Trained[],
  splitAt: number, start: number, distribution: DerivedDistribution,
  bankStats: SpeedBankExtractionStats, emaStats: ExtractionStats) {
  for (const model of trained) {
    model.quality.beginMarket();
    model.train.set(market.name, newTrainCounts());
  }
  const banks = new SpeedBanks();
  const ema = new PriceEma();
  const pending: Origin[] = [];
  let head = 0;
  for (const tick of readTicks(db, market.id, -Number.MAX_SAFE_INTEGER, start)) {
    const states = banks.update(tick.t, tick.p);
    const e = ema.update(tick.t, tick.p);
    updateStats(bankStats.direct, states.direct);
    updateStats(bankStats.derived, states.derived);
    if (e === null) emaStats.warmup++; else emaStats.ready++;
    if (tick.t < splitAt && states.derived && states.derived.cell >= 0) {
      observeDerivedDistribution(distribution, states.derived);
    }
    while (head < pending.length && pending[head].t + HORIZON <= tick.t) {
      resolveTrain(pending[head++], tick, e, trained, splitAt, market.name);
    }
    if (head > 4096 && head * 2 > pending.length) {
      pending.splice(0, head);
      head = 0;
    }
    if (tick.t >= splitAt) continue;
    const origin: Origin = { ...tick, e, ...states };
    for (const model of trained) {
      const counts = model.train.get(market.name)!;
      counts.origins++;
      const state = stateOf(origin, model.model.id);
      if (state === null || state.cell < 0) counts.invalidFeature++;
      else if (tick.t + HORIZON >= splitAt) counts.purged++;
    }
    if (tick.t + HORIZON < splitAt &&
      ((states.direct && states.direct.cell >= 0) ||
        (states.derived && states.derived.cell >= 0))) pending.push(origin);
  }
  for (; head < pending.length; head++) {
    for (const model of trained) {
      const state = stateOf(pending[head], model.model.id);
      if (state && state.cell >= 0) model.train.get(market.name)!.purged++;
    }
  }
  for (const model of trained) model.quality.endMarket(market.name);
  return { banks, ema };
}

const META_CELL_COUNT = (FORECAST_BINS.length + 1) ** 2;
function metaIndex(direct: number, derived: number) {
  return bin(direct, FORECAST_BINS) * (FORECAST_BINS.length + 1) +
    bin(derived, FORECAST_BINS);
}
type MetaCoverage = {
  origins: number; commonForecasts: number; valid: number;
  purged: number; late: number; emaUnavailable: number;
  lastTarget: number;
};
class MetaGrid {
  readonly count = new Float64Array(META_CELL_COUNT);
  readonly mean = new Float64Array(META_CELL_COUNT);
  readonly m2 = new Float64Array(META_CELL_COUNT);
  readonly spacedCount = new Float64Array(META_CELL_COUNT);
  readonly spacedMean = new Float64Array(META_CELL_COUNT);
  readonly spacedM2 = new Float64Array(META_CELL_COUNT);
  readonly anchorSum = new Float64Array(META_CELL_COUNT);
  readonly actualSum = new Float64Array(META_CELL_COUNT);
  readonly marketCount = new Uint32Array(META_CELL_COUNT);
  readonly largestMarketCount = new Float64Array(META_CELL_COUNT);
  readonly largestMarket = new Array<string>(META_CELL_COUNT).fill('');
  readonly correction = new Float64Array(META_CELL_COUNT);
  readonly reliability = new Float64Array(META_CELL_COUNT);
  private readonly marketSamples = new Uint32Array(META_CELL_COUNT);
  private readonly lastTarget = new Float64Array(META_CELL_COUNT);
  pooledVariance = NaN;
  priorVariance = NaN;
  estimatedCells = 0;
  readonly coverage: MetaCoverage = {
    origins: 0, commonForecasts: 0, valid: 0, purged: 0,
    late: 0, emaUnavailable: 0, lastTarget: -Infinity,
  };
  beginMarket() {
    this.marketSamples.fill(0);
    this.lastTarget.fill(-Infinity);
  }
  observe(origin: Origin, target: Tick, actual: number) {
    const [direct, derived] = origin.forecasts!;
    const cell = metaIndex(direct, derived);
    const anchor = (direct + derived) / 2;
    const value = actual - anchor;
    const n = ++this.count[cell];
    const delta = value - this.mean[cell];
    this.mean[cell] += delta / n;
    this.m2[cell] += delta * (value - this.mean[cell]);
    this.anchorSum[cell] += anchor;
    this.actualSum[cell] += actual;
    this.marketSamples[cell]++;
    if (origin.t >= this.lastTarget[cell]) {
      const spaced = ++this.spacedCount[cell];
      const spacedDelta = value - this.spacedMean[cell];
      this.spacedMean[cell] += spacedDelta / spaced;
      this.spacedM2[cell] += spacedDelta *
        (value - this.spacedMean[cell]);
      this.lastTarget[cell] = target.t;
    }
    this.coverage.valid++;
    this.coverage.lastTarget = Math.max(this.coverage.lastTarget, target.t);
  }
  endMarket(name: string) {
    for (let cell = 0; cell < META_CELL_COUNT; cell++) {
      const n = this.marketSamples[cell];
      if (n) this.marketCount[cell]++;
      if (n > this.largestMarketCount[cell]) {
        this.largestMarketCount[cell] = n;
        this.largestMarket[cell] = name;
      }
    }
  }
  freeze() {
    let pooledM2 = 0;
    let pooledDf = 0;
    for (let i = 0; i < META_CELL_COUNT; i++) {
      const n = this.spacedCount[i];
      if (n > 1) {
        pooledM2 += this.spacedM2[i];
        pooledDf += n - 1;
      }
    }
    this.pooledVariance = pooledDf ? pooledM2 / pooledDf : 1;
    let secondMoment = 0;
    let samplingVariance = 0;
    for (let i = 0; i < META_CELL_COUNT; i++) {
      const n = this.spacedCount[i];
      if (this.count[i] < META_MIN_SAMPLES ||
        n < META_MIN_SPACED) continue;
      const variance = this.spacedM2[i] / (n - 1);
      secondMoment += this.mean[i] ** 2;
      samplingVariance += variance / n;
      this.estimatedCells++;
    }
    this.priorVariance = Math.max(1e-6,
      (secondMoment - samplingVariance) /
        Math.max(1, this.estimatedCells));
    for (let i = 0; i < META_CELL_COUNT; i++) {
      const n = this.spacedCount[i];
      if (this.count[i] < META_MIN_SAMPLES ||
        n < META_MIN_SPACED) continue;
      const variance = this.spacedM2[i] / (n - 1);
      const se2 = Math.max(0, Number.isFinite(variance)
        ? variance : this.pooledVariance) / n;
      this.reliability[i] = this.priorVariance /
        (this.priorVariance + se2);
      this.correction[i] = this.mean[i] * this.reliability[i];
    }
  }
  predict(direct: number, derived: number) {
    if (!Number.isFinite(direct)) return derived;
    if (!Number.isFinite(derived)) return direct;
    return (direct + derived) / 2 +
      this.correction[metaIndex(direct, derived)];
  }
}
function fitMetaMarket(db: DatabaseSync, market: Market,
  filters: { banks: SpeedBanks; ema: PriceEma },
  trained: readonly Trained[], grid: MetaGrid,
  metaStart: number, splitAt: number) {
  grid.beginMarket();
  const pending: Origin[] = [];
  let head = 0;
  for (const tick of readTicks(db, market.id, metaStart, splitAt)) {
    const state = filters.banks.update(tick.t, tick.p);
    const e = filters.ema.update(tick.t, tick.p);
    while (head < pending.length && pending[head].t + HORIZON <= tick.t) {
      const origin = pending[head++];
      if (tick.t - origin.t - HORIZON > MAX_TARGET_DELAY) {
        grid.coverage.late++;
      } else if (origin.e === null || e === null) {
        grid.coverage.emaUnavailable++;
      } else {
        grid.observe(origin, tick, labelReturns(origin, tick, e).residual);
      }
    }
    if (head > 4096 && head * 2 > pending.length) {
      pending.splice(0, head);
      head = 0;
    }
    grid.coverage.origins++;
    const direct = forecast(state.direct, trained[0].table!.table);
    const derived = forecast(state.derived, trained[1].table!.table);
    if (!Number.isFinite(direct) || !Number.isFinite(derived) ||
      direct === 0 || derived === 0) continue;
    grid.coverage.commonForecasts++;
    if (tick.t + HORIZON >= splitAt) {
      grid.coverage.purged++;
    } else {
      pending.push({ ...tick, e, ...state,
        forecasts: [direct, derived, NaN] });
    }
  }
  grid.coverage.purged += pending.length - head;
  grid.endMarket(market.name);
}

type Calibration = {
  samples: number; statuses: Record<string, number>; unavailable: number;
  forecast: number; actual: number; correct: number; wrong: number; flat: number;
};
function newCalibration(): Calibration { return {
  samples: 0, statuses: { valid: 0, 'horizon-after-end': 0,
    'no-target': 0, 'late-target': 0 }, unavailable: 0,
  forecast: 0, actual: 0, correct: 0, wrong: 0, flat: 0,
}; }
function calibrationKey(market: string, model: ModelId,
  basis: string, kind: string, sign: number, min: number, max: number | null) {
  return JSON.stringify([market, model, basis, kind, sign, min, max]);
}
class TestStats {
  readonly calibration = new Map<string, Calibration>();
  readonly pairs = new Map<string, PairAggregate>();
  readonly grid = new Map<string, PairAggregate>();
  readonly timeGrid = new Map<string, PairAggregate>();
  readonly tailByBlock = new Map<string, PairAggregate>();
  readonly combinedPairs = new Map<string,
    [PairAggregate, PairAggregate]>();
  readonly coverage = { origins: 0, commonForecasts: 0,
    commonValidLabels: 0, lateTargets: 0, noTargets: 0 };
  readonly market: string;
  constructor(market: string) { this.market = market; }
  private groups(model: ModelId, f: number, basis: string) {
    const values: string[] = [];
    for (const threshold of CALIBRATION_THRESHOLDS) {
      if (Math.abs(f) >= threshold) values.push(calibrationKey(
        this.market, model, basis, 'threshold', Math.sign(f), threshold, null));
    }
    for (const [min, max] of ENTRY_BANDS) {
      if (Math.abs(f) >= min && (max === null || Math.abs(f) < max)) {
        values.push(calibrationKey(this.market, model, basis,
          'band', Math.sign(f), min, max));
        break;
      }
    }
    return values;
  }
  onOrigin(origin: Origin) {
    this.coverage.origins++;
    origin.calibrationGroups = [];
    for (const [i, model] of EVAL_MODELS.entries()) {
      const f = origin.forecasts![i];
      if (!Number.isFinite(f) || f === 0) continue;
      for (const basis of ['ema-residual', 'raw'] as const) {
        for (const key of this.groups(model, f, basis)) {
          const group = this.calibration.get(key) ?? newCalibration();
          group.samples++;
          this.calibration.set(key, group);
          origin.calibrationGroups.push({ group, basis, forecast: f });
        }
      }
    }
    if (origin.forecasts!.every((v) => Number.isFinite(v) && v !== 0)) {
      this.coverage.commonForecasts++;
    }
  }
  onLabel(origin: Origin, status: string,
    actual?: { residual: number; raw: number }) {
    for (const { group, basis, forecast: f } of origin.calibrationGroups!) {
      if (status === 'ema-unavailable') group.unavailable++;
      else group.statuses[status]++;
      if (status !== 'valid') continue;
      const v = actual![basis === 'raw' ? 'raw' : 'residual'];
      group.forecast += f;
      group.actual += v;
      group.correct += Number(v * f > 0);
      group.wrong += Number(v * f < 0);
      group.flat += Number(v === 0);
    }
    if (status === 'valid') {
      const block = Math.floor(origin.t / TEST_BLOCK_MS) * TEST_BLOCK_MS;
      for (const [i, model] of EVAL_MODELS.entries()) {
        const f = origin.forecasts![i];
        if (!Number.isFinite(f) || Math.abs(f) < 2.5 ||
          Math.abs(f) >= 3) continue;
        const tailKey = `${block}:${model}:${Math.sign(f)}`;
        const tail = this.tailByBlock.get(tailKey) ?? newPairAggregate();
        observePair(tail, f, f, actual!.residual, actual!.raw);
        this.tailByBlock.set(tailKey, tail);
      }
    }
    const [direct, derived] = origin.forecasts!;
    if (!Number.isFinite(direct) || !Number.isFinite(derived) ||
      direct === 0 || derived === 0) return;
    if (status === 'late-target') this.coverage.lateTargets++;
    if (status === 'no-target') this.coverage.noTargets++;
    if (status !== 'valid') return;
    this.coverage.commonValidLabels++;
    const cohorts = pairCohorts(direct, derived,
      'speed-bank', 'speed-bank-derived');
    for (const cohort of cohorts) {
      const g = this.pairs.get(cohort) ?? newPairAggregate();
      observePair(g, direct, derived, actual!.residual, actual!.raw);
      this.pairs.set(cohort, g);
    }
    const key = `${bin(direct, FORECAST_BINS)},${bin(derived, FORECAST_BINS)}`;
    const g = this.grid.get(key) ?? newPairAggregate();
    observePair(g, direct, derived, actual!.residual, actual!.raw);
    this.grid.set(key, g);
    const block = Math.floor(origin.t / TEST_BLOCK_MS) * TEST_BLOCK_MS;
    const timeKey = `${block}:${key}`;
    const time = this.timeGrid.get(timeKey) ?? newPairAggregate();
    observePair(time, direct, derived, actual!.residual, actual!.raw);
    this.timeGrid.set(timeKey, time);
    const combined = origin.forecasts![2];
    if (Math.sign(direct) !== Math.sign(derived)) {
      cohorts.push('opposite-sign');
    }
    for (const threshold of [1, 2, 2.5]) {
      if (Math.abs(combined) >= threshold) {
        cohorts.push(`combined>=${threshold}`);
      }
    }
    for (const cohort of cohorts) {
      const aggregates = this.combinedPairs.get(cohort) ??
        [newPairAggregate(), newPairAggregate()] as
          [PairAggregate, PairAggregate];
      observePair(aggregates[0], direct, combined,
        actual!.residual, actual!.raw);
      observePair(aggregates[1], derived, combined,
        actual!.residual, actual!.raw);
      this.combinedPairs.set(cohort, aggregates);
    }
  }
}
function forecast(state: { cell: number; sign: number } | null,
  table: Float64Array) {
  return state && state.cell >= 0 ? table[state.cell] * state.sign : NaN;
}
function testMarket(db: DatabaseSync, market: Market,
  filters: { banks: SpeedBanks; ema: PriceEma },
  trained: readonly Trained[], meta: MetaGrid,
  start: number, end: number,
  totals: TestStats) {
  const pending: Origin[] = [];
  let head = 0;
  for (const tick of readTicks(db, market.id, start, end + 1)) {
    const states = filters.banks.update(tick.t, tick.p);
    const e = filters.ema.update(tick.t, tick.p);
    while (head < pending.length && pending[head].t + HORIZON <= tick.t) {
      const origin = pending[head++];
      const delay = tick.t - origin.t - HORIZON;
      const status = delay > MAX_TARGET_DELAY ? 'late-target' :
        origin.e === null || e === null ? 'ema-unavailable' : 'valid';
      totals.onLabel(origin, status, status === 'valid'
        ? labelReturns(origin, tick, e!) : undefined);
    }
    if (head > 4096 && head * 2 > pending.length) {
      pending.splice(0, head);
      head = 0;
    }
    const direct = forecast(states.direct, trained[0].table!.table);
    const derived = forecast(states.derived, trained[1].table!.table);
    const origin: Origin = { ...tick, e, ...states,
      forecasts: [direct, derived, meta.predict(direct, derived)],
    };
    totals.onOrigin(origin);
    if (origin.forecasts!.some((f) => Number.isFinite(f) && f !== 0)) {
      if (origin.t + HORIZON > end) totals.onLabel(origin, 'horizon-after-end');
      else pending.push(origin);
    }
  }
  for (; head < pending.length; head++) totals.onLabel(pending[head], 'no-target');
}
function combinePair(into: PairAggregate, from: PairAggregate) {
  for (const key of Object.keys(into) as (keyof PairAggregate)[]) {
    into[key] += from[key];
  }
}
function gridValues(key: string, g: PairAggregate) {
  const [left, right] = key.split(',').map(Number);
  const n = g.count;
  const variance = Math.max(0,
    g.residualSquared / n - (g.residual / n) ** 2);
  return [
    left, left ? FORECAST_BINS[left - 1] : null,
    left === FORECAST_BINS.length ? null : FORECAST_BINS[left],
    right, right ? FORECAST_BINS[right - 1] : null,
    right === FORECAST_BINS.length ? null : FORECAST_BINS[right],
    n, g.leftForecast / n, g.rightForecast / n,
    g.residual / n, g.raw / n,
    n > 1 ? Math.sqrt(variance) : null,
    n > 1 ? Math.sqrt(variance / n) : null,
    g.leftCorrect / n, g.rightCorrect / n,
  ];
}
function comparisonValues(cohort: string, g: PairAggregate,
  left: ModelId, right: ModelId) {
  const n = g.count;
  return [cohort, n, left, right,
    g.leftForecast / n, g.rightForecast / n,
    g.residual / n, g.raw / n,
    g.leftDirectional / n, g.rightDirectional / n,
    g.leftRawDirectional / n, g.rightRawDirectional / n,
    g.leftCorrect / n, g.rightCorrect / n,
    g.leftRawCorrect / n, g.rightRawCorrect / n,
    g.leftAbsError / n, g.rightAbsError / n,
    Math.sqrt(g.leftSquaredError / n),
    Math.sqrt(g.rightSquaredError / n)];
}
const COMPARE_HEADERS = [
  'cohort', 'samples', 'leftModel', 'rightModel',
  'meanLeftForecastPermille', 'meanRightForecastPermille',
  'meanActualResidualPermille', 'meanRawReturnPermille',
  'meanLeftDirectionalResidualPermille', 'meanRightDirectionalResidualPermille',
  'meanLeftDirectionalRawPermille', 'meanRightDirectionalRawPermille',
  'leftResidualDirectionAccuracy', 'rightResidualDirectionAccuracy',
  'leftRawDirectionAccuracy', 'rightRawDirectionAccuracy',
  'leftMAEPermille', 'rightMAEPermille', 'leftRMSEPermille',
  'rightRMSEPermille',
];
const GRID_HEADERS = [
  'directBin', 'directMinInclusive', 'directMaxExclusive',
  'derivedBin', 'derivedMinInclusive', 'derivedMaxExclusive',
  'samples', 'meanDirectForecastPermille', 'meanDerivedForecastPermille',
  'meanActualResidualPermille', 'meanRawReturnPermille',
  'residualStdDevPermille', 'residualStdErrorPermille',
  'directDirectionAccuracy', 'derivedDirectionAccuracy',
];
async function writeCalibration(dir: string, id: ModelId,
  stats: readonly TestStats[]) {
  const threshold = await Csv.create(resolve(dir,
    'forecast-calibration.csv'), [
      'market', 'priceBasis', 'direction', 'absForecastThreshold',
      'samples', 'validTargets', 'horizonAfterEnd', 'noTarget',
      'lateTarget', 'emaUnavailable', 'meanForecastPermille',
      'meanActualPermille', 'meanDirectionalReturnPermille',
      'correctDirection', 'wrongDirection', 'flat', 'directionAccuracy',
    ]);
  const bands = await Csv.create(resolve(dir,
    'forecast-band-calibration.csv'), [
      'market', 'priceBasis', 'direction', 'absForecastMinInclusive',
      'absForecastMaxExclusive', 'samples', 'validTargets',
      'horizonAfterEnd', 'noTarget', 'lateTarget', 'emaUnavailable',
      'meanForecastPermille', 'meanActualPermille',
      'meanDirectionalReturnPermille', 'correctDirection',
      'wrongDirection', 'flat', 'directionAccuracy',
    ]);
  try {
    for (const stat of stats) {
      for (const [key, g] of stat.calibration) {
        const [market, modelId, basis, kind, sign, min, max] =
          JSON.parse(key);
        if (modelId !== id) continue;
        const n = g.statuses.valid;
        const row = [market, basis, sign > 0 ? 'up' : 'down', min];
        if (kind === 'band') row.push(max);
        row.push(g.samples, n, g.statuses['horizon-after-end'],
          g.statuses['no-target'], g.statuses['late-target'], g.unavailable,
          n ? g.forecast / n : null, n ? g.actual / n : null,
          n ? g.actual * sign / n : null,
          g.correct, g.wrong, g.flat, n ? g.correct / n : null);
        await (kind === 'band' ? bands : threshold).row(row);
      }
    }
  } finally { await threshold.close(); await bands.close(); }
}
async function writeAggregates(directory: string, trained: readonly Trained[],
  markets: readonly Market[], selected: readonly Market[],
  range: { first: number; last: number; n: number },
  baseEnd: number, splitAt: number, meta: MetaGrid,
  start: number, end: number, dbMetadata: Record<string, string>,
  distribution: DerivedDistribution, bankStats: SpeedBankExtractionStats,
  emaStats: ExtractionStats, stats: readonly TestStats[]) {
  await writeDerivedFeatureDistribution(resolve(directory,
    'derived-feature-distribution.csv'), distribution);
  const tableHashes: Record<string, string> = {};
  for (const model of trained) {
    const dir = resolve(directory, `tau-${PRICE_EMA_TAU_MS}ms`, model.model.id);
    await mkdir(dir, { recursive: true });
    const quality = await Csv.create(resolve(dir, 'cell-quality.csv'), [
      'cell', 'forecastEnabled', 'trainSamples', 'rawAlignedMeanPermille',
      'shrunkAlignedForecastPermille', 'softReliability', 'effectiveSamples',
      'standardErrorPermille', 'sampleStdDevPermille', 'minPermille',
      'maxPermille', 'positiveFraction', 'trainingMarkets', 'largestMarket',
      'largestMarketSampleShare', 'nonOverlappingSamples',
      'nonOverlappingAlignedMeanPermille', 'nonOverlappingStdDevPermille',
      'blockBoundaryPurged', 'flags',
    ]);
    const blocks = await Csv.create(resolve(dir, 'cell-time-blocks.csv'), [
      'cell', 'block', 'startInclusive', 'endExclusive', 'samples',
      'alignedMeanPermille', 'sampleStdDevPermille', 'enoughBlockSamples',
    ]);
    try { await writeQuality(model.quality, model.cells,
      model.table!, quality, blocks); }
    finally { await quality.close(); await blocks.close(); }
    const coverage = await Csv.create(resolve(dir, 'training.csv'), [
      'market', ...Object.keys(newTrainCounts()),
    ]);
    try {
      for (const market of markets) await coverage.row([
        market.name, ...Object.values(model.train.get(market.name)!),
      ]);
    } finally { await coverage.close(); }
    const lastTrainTarget = Math.max(...Array.from(model.train.values(),
      (c) => c.lastTarget));
    const frozen = JSON.stringify({
      version: 6, model: model.model.id,
      source: 'read-only prepared SQLite cache, early base-fit period',
      targetDefinition: targetDefinition(), horizonMs: HORIZON,
      baseFitEnd: new Date(baseEnd).toISOString(),
      trainSamples: Array.from(model.train.values()).reduce(
        (sum, c) => sum + c.accepted, 0),
      lastTrainTarget: Number.isFinite(lastTrainTarget)
        ? new Date(lastTrainTarget).toISOString() : null,
      minTrainSamples: MIN_TRAIN_SAMPLES,
      stateCount: model.model.stateCount, trainingMarkets: markets,
      tradingMarkets: selected.map((m) => m.name),
      maxTargetDelayMs: MAX_TARGET_DELAY,
      ...modelFrozenMetadata(model.model),
      reliability: { method: 'empirical-bayes-zero-prior',
        priorVariance: model.table!.priorVariance,
        pooledVariance: model.table!.pooledVariance,
        meanSamplingVariance: model.table!.meanSamplingVariance,
        estimatedCells: model.table!.estimatedCells,
        effectiveSampleDefinition: 'non-overlapping 60s labels per cell' },
      mean: Array.from(model.table!.table), rawMean: Array.from(model.cells.mean),
      reliabilityFactor: Array.from(model.table!.factor),
      effectiveSamples: Array.from(model.table!.effectiveSamples),
      standardError: Array.from(model.table!.standardError),
      count: Array.from(model.cells.count),
      variance: Array.from(model.cells.count,
        (n, i) => n ? model.cells.m2[i] / n : null),
    }, null, 2) + '\n';
    await writeFile(resolve(dir, 'frozen-table.json'), frozen);
    tableHashes[model.model.id] = createHash('sha256')
      .update(frozen).digest('hex');
    await writeCalibration(dir, model.model.id, stats);
  }
  const combinedDir = resolve(directory, `tau-${PRICE_EMA_TAU_MS}ms`,
    'combined');
  await mkdir(combinedDir, { recursive: true });
  await writeCalibration(combinedDir, 'combined', stats);
  const metaCells = await Csv.create(resolve(combinedDir, 'meta-cells.csv'), [
    'directBin', 'derivedBin', 'samples', 'nonOverlappingSamples',
    'meanDirectDerivedAnchorPermille', 'meanActualResidualPermille',
    'meanCorrectionPermille', 'shrunkCorrectionPermille',
    'softReliability', 'trainingMarkets', 'largestMarket',
    'largestMarketSampleShare',
  ]);
  try {
    for (let i = 0; i < META_CELL_COUNT; i++) {
      const n = meta.count[i];
      if (!n) continue;
      await metaCells.row([
        Math.floor(i / (FORECAST_BINS.length + 1)),
        i % (FORECAST_BINS.length + 1), n, meta.spacedCount[i],
        meta.anchorSum[i] / n, meta.actualSum[i] / n,
        meta.mean[i], meta.correction[i], meta.reliability[i],
        meta.marketCount[i], meta.largestMarket[i],
        meta.largestMarketCount[i] / n,
      ]);
    }
  } finally { await metaCells.close(); }
  const frozenMeta = JSON.stringify({
    version: 6, model: 'combined', bins: FORECAST_BINS,
    baseFitEnd: new Date(baseEnd).toISOString(),
    metaFitEnd: new Date(splitAt).toISOString(),
    targetDefinition: targetDefinition(), horizonMs: HORIZON,
    formula: 'anchor=(forecast3+forecast4)/2; forecast=anchor+cellCorrection',
    fallback: 'missing one forecast: use the available forecast; unseen/sparse pair: anchor',
    minSamples: META_MIN_SAMPLES, minNonOverlapping: META_MIN_SPACED,
    correctionPrior: 'zero-mean empirical-Bayes shrinkage on meta-fit residuals',
    effectiveSamples: 'non-overlapping 60s labels per market and pair bin',
    pooledVariance: meta.pooledVariance,
    priorVariance: meta.priorVariance,
    estimatedCells: meta.estimatedCells,
    coverage: meta.coverage,
    count: Array.from(meta.count),
    nonOverlappingCount: Array.from(meta.spacedCount),
    rawMeanCorrection: Array.from(meta.mean),
    reliability: Array.from(meta.reliability),
    correction: Array.from(meta.correction),
  }, null, 2) + '\n';
  await writeFile(resolve(combinedDir, 'frozen-combiner.json'), frozenMeta);
  tableHashes.combined = createHash('sha256')
    .update(frozenMeta).digest('hex');
  if (!SELF_TEST) {
    assert.deepEqual(tableHashes, EXPECTED_TABLE_HASHES,
      'Frozen v6 tables changed; historical cache or settings differ');
  }
  const comparisonDir = resolve(directory, `tau-${PRICE_EMA_TAU_MS}ms`,
    'comparison', 'speed-bank-vs-derived');
  await mkdir(comparisonDir, { recursive: true });
  const pairs = new Map<string, PairAggregate>();
  const grid = new Map<string, PairAggregate>();
  const timeGrid = new Map<string, PairAggregate>();
  const combinedPairs = new Map<string,
    [PairAggregate, PairAggregate]>();
  const coverage = { origins: 0, commonForecasts: 0,
    commonValidLabels: 0, lateTargets: 0, noTargets: 0 };
  for (const stat of stats) {
    for (const [key, value] of Object.entries(stat.coverage)) {
      coverage[key as keyof typeof coverage] += value;
    }
    for (const [key, g] of stat.pairs) {
      const sum = pairs.get(key) ?? newPairAggregate();
      combinePair(sum, g); pairs.set(key, sum);
    }
    for (const [key, g] of stat.grid) {
      const sum = grid.get(key) ?? newPairAggregate();
      combinePair(sum, g); grid.set(key, sum);
    }
    for (const [key, g] of stat.timeGrid) {
      const sum = timeGrid.get(key) ?? newPairAggregate();
      combinePair(sum, g); timeGrid.set(key, sum);
    }
    for (const [key, aggregates] of stat.combinedPairs) {
      const sum = combinedPairs.get(key) ??
        [newPairAggregate(), newPairAggregate()] as
          [PairAggregate, PairAggregate];
      combinePair(sum[0], aggregates[0]);
      combinePair(sum[1], aggregates[1]);
      combinedPairs.set(key, sum);
    }
  }
  const summary = await Csv.create(resolve(comparisonDir,
    'common-comparison.csv'), COMPARE_HEADERS);
  const forecastGrid = await Csv.create(resolve(comparisonDir,
    'forecast-grid.csv'), GRID_HEADERS);
  try {
    for (const [cohort, g] of pairs) {
      await summary.row(comparisonValues(cohort, g,
        'speed-bank', 'speed-bank-derived'));
    }
    for (const [key, g] of grid) {
      await forecastGrid.row(gridValues(key, g));
    }
  } finally { await summary.close(); await forecastGrid.close(); }
  const byMarket = await Csv.create(resolve(comparisonDir,
    'forecast-grid-by-market.csv'), ['market', ...GRID_HEADERS]);
  const byTime = await Csv.create(resolve(comparisonDir,
    'forecast-grid-by-time-block.csv'), [
    'blockStartUtcMs', 'blockEndUtcMs', ...GRID_HEADERS,
  ]);
  const tails = await Csv.create(resolve(comparisonDir,
    'strong-tail-by-market-time-block.csv'), [
    'market', 'blockStartUtcMs', 'blockEndUtcMs', 'model', 'direction',
    'samples', 'meanForecastPermille',
    'meanDirectionalResidualPermille', 'meanDirectionalRawPermille',
    'residualDirectionAccuracy', 'rawDirectionAccuracy',
  ]);
  const combined = await Csv.create(resolve(comparisonDir,
    'combined-comparison.csv'), COMPARE_HEADERS);
  try {
    for (const stat of stats) {
      for (const [key, g] of stat.grid) {
        await byMarket.row([stat.market, ...gridValues(key, g)]);
      }
      for (const [key, g] of stat.tailByBlock) {
        const [blockText, model, signText] = key.split(':');
        const block = Number(blockText);
        const sign = Number(signText);
        const n = g.count;
        await tails.row([
          stat.market, block, block + TEST_BLOCK_MS, model,
          sign > 0 ? 'up' : 'down', n, g.leftForecast / n,
          g.leftDirectional / n, g.leftRawDirectional / n,
          g.leftCorrect / n, g.leftRawCorrect / n,
        ]);
      }
    }
    for (const [key, g] of timeGrid) {
      const [blockText, cellKey] = key.split(':');
      const block = Number(blockText);
      await byTime.row([block, block + TEST_BLOCK_MS,
        ...gridValues(cellKey, g)]);
    }
    for (const [cohort, aggregates] of combinedPairs) {
      for (const [i, model] of MODELS.entries()) {
        await combined.row(comparisonValues(cohort, aggregates[i],
          model.id, 'combined'));
      }
    }
  } finally {
    await byMarket.close();
    await byTime.close();
    await tails.close();
    await combined.close();
  }
  await writeFile(resolve(comparisonDir, 'common-comparison.json'),
    JSON.stringify({ ...coverage, comparisonThresholds: ENTRY_THRESHOLDS,
      forecastBins: FORECAST_BINS, testBlockMs: TEST_BLOCK_MS,
      note: 'All test grids are descriptive; combiner was frozen on meta-fit before test.',
      standardErrorNote: 'Tick-level standard errors ignore overlap of 60s labels and market/time dependence.',
    }, null, 2) + '\n');
  await writeFile(resolve(directory, 'comparison.json'), JSON.stringify({
    version: 6, status: 'complete',
    researchCache: { path: RESEARCH_CACHE_PATH, metadata: dbMetadata },
    targetDefinition: targetDefinition(),
    targetTauMs: PRICE_EMA_TAU_MS,
    observations: range,
    splitAt: new Date(splitAt).toISOString(),
    testStart: new Date(start).toISOString(),
    testEnd: new Date(end).toISOString(),
    models: EVAL_MODELS, tableHashes, trainingMarkets: markets.length,
    testMarkets: selected.map((m) => m.name),
    baseFitEnd: new Date(baseEnd).toISOString(),
    metaFitEnd: new Date(splitAt).toISOString(),
    metaFitCoverage: meta.coverage,
    bankStats, emaStats, coverage,
    validationNote: SELF_TEST ? 'Synthetic self-test.' :
      'Original v6 table hashes verified. Only previously unseen ticks ' +
      'at or after the old exclusive test end are evaluated.',
    pipeline: 'read-only cache; preliminary range/count query, then disjoint base-fit, meta-fit and test streams; no trading replay or per-event files',
  }, null, 2) + '\n');
}

async function analyze(db: DatabaseSync, output: string) {
  const schema = (db.prepare('PRAGMA user_version').get() as
    { user_version: number }).user_version;
  if (schema !== 1) throw new Error(`Unsupported cache schema: ${schema}`);
  const dbMetadata = Object.fromEntries((db.prepare(
    'SELECT key, value FROM metadata').all() as
    { key: string; value: string }[]).map(({ key, value }) => [key, value]));
  const markets = db.prepare(`SELECT id,name,stock,money FROM markets
    WHERE type='spot' AND EXISTS (SELECT 1 FROM observations
      WHERE market_id=markets.id) ORDER BY name`).all() as Market[];
  if (!markets.length) throw new Error('No cached spot markets');
  const raw = db.prepare(`SELECT min(o.received_at) AS first,
    max(o.received_at) AS last, count(*) AS n FROM observations o
    JOIN markets m ON m.id=o.market_id WHERE m.type='spot'
    AND (? IS NULL OR o.received_at<=?)`).get(DATA_END, DATA_END) as
    { first: number | null; last: number | null; n: number };
  if (raw.first === null || raw.last === null) throw new Error('No observations');
  const range = { first: raw.first, last: raw.last, n: raw.n };
  const splitAt = REQUESTED_SPLIT ?? Math.ceil(range.first +
    TRAIN_FRACTION * (range.last - range.first));
  const baseEnd = Math.ceil(range.first +
    BASE_FIT_FRACTION * (splitAt - range.first));
  const start = REQUESTED_START ?? splitAt;
  const end = REQUESTED_END ?? range.last;
  if (!SELF_TEST) {
    assert.equal(range.first, EXPECTED_FIRST_SPOT_TICK,
      'Historical first spot observation changed');
    assert.equal(new Date(baseEnd).toISOString(), EXPECTED_BASE_FIT_END,
      'Original base-fit boundary changed');
    assert.equal(new Date(splitAt).toISOString(), SPLIT_AT_ISO);
    assert.equal(new Date(start).toISOString(), TEST_START_ISO);
  }
  if (baseEnd <= range.first + HORIZON ||
    baseEnd + HORIZON >= splitAt || splitAt >= range.last ||
    start < splitAt || start >= end || end > range.last) {
    throw new Error('Invalid base-fit/meta-fit/test boundaries');
  }
  const requested = process.env.MF_MARKETS === undefined ? MARKET_NAMES :
    process.env.MF_MARKETS.split(',').map((x) => x.trim()).filter(Boolean);
  const eligible = markets.filter((m) => m.money === BASE_CURRENCY &&
    m.stock !== BASE_CURRENCY);
  for (const name of requested) {
    if (!eligible.some((m) => m.name === name)) {
      throw new Error(`No cached spot market quoted in ${BASE_CURRENCY}: ${name}`);
    }
  }
  const selected = eligible.filter((m) => !requested.length ||
    requested.includes(m.name));
  if (!selected.length) throw new Error('No test markets selected');
  const trained: Trained[] = MODELS.map((model) => ({ model,
    cells: newCells(), quality: new CellQuality(range.first, baseEnd),
    train: new Map<string, TrainCounts>(),
  }));
  const bankStats: SpeedBankExtractionStats = {
    direct: { ready: 0, warmup: 0, invalid: 0 },
    derived: { ready: 0, warmup: 0, invalid: 0 },
  };
  const emaStats: ExtractionStats = { ready: 0, warmup: 0, invalid: 0 };
  const distribution = newDerivedDistribution();
  const filters = new Map<number, { banks: SpeedBanks; ema: PriceEma }>();
  for (const market of markets) {
    const state = trainMarket(db, market, trained, baseEnd, baseEnd,
      distribution, bankStats, emaStats);
    filters.set(market.id, state);
    console.log(`Base-fit ${market.name}: ${trained.map((m) =>
      `${m.model.id}=${m.train.get(market.name)!.accepted}`).join(', ')}`);
  }
  for (const model of trained) {
    model.table = buildSoftReliability(model.cells, model.quality);
    if (!model.table.table.some(Number.isFinite)) {
      throw new Error(`${model.model.id}: no usable trained cells`);
    }
  }
  const meta = new MetaGrid();
  for (const market of markets) {
    fitMetaMarket(db, market, filters.get(market.id)!, trained,
      meta, baseEnd, splitAt);
    console.log(`Meta-fit ${market.name}`);
  }
  meta.freeze();
  if (!meta.coverage.valid) throw new Error('No valid meta-fit labels');
  const stats: TestStats[] = [];
  for (const market of selected) {
    const state = filters.get(market.id)!;
    for (const tick of readTicks(db, market.id, splitAt, start)) {
      state.banks.update(tick.t, tick.p);
      state.ema.update(tick.t, tick.p);
    }
    const stat = new TestStats(market.name);
    testMarket(db, market, state, trained, meta, start, end, stat);
    stats.push(stat);
    console.log(`Test ${market.name}: common=${stat.coverage.commonValidLabels}`);
  }
  await writeAggregates(output, trained, markets, selected, range,
    baseEnd, splitAt, meta, start, end, dbMetadata, distribution,
    bankStats, emaStats, stats);
}

async function main() {
  await mkdir(OUTPUT, { recursive: true });
  const db = new DatabaseSync(RESEARCH_CACHE_PATH, { readOnly: true });
  try {
    const output = await mkdtemp(resolve(OUTPUT, 'run-'));
    await analyze(db, output);
    console.log(`Comparison run: ${output}`);
  } finally { db.close(); }
}

async function selfTest() {
  assert.equal(SPEED_BANK_STATE_COUNT, 2548);
  assert.equal(DERIVED_SPEED_BANK_STATE_COUNT, 2548);
  const up = speedBankCell([2, 1, 0.5]);
  const down = speedBankCell([-2, -1, -0.5]);
  assert.equal(up.cell, down.cell);
  assert.equal(up.sign, -down.sign);
  const a = derivedSpeedBankCell([2, 1, 0.5, 0.25]);
  const b = derivedSpeedBankCell([-2, -1, -0.5, -0.25]);
  assert.equal(a.cell, b.cell);
  const learned = new MetaGrid();
  learned.beginMarket();
  for (let i = 0; i < 40; i++) {
    const t = i * 70_000;
    learned.observe({ t, p: 100, e: 100,
      direct: null, derived: null, forecasts: [1, 2, NaN] },
    { t: t + HORIZON, p: 100 }, 2.5);
  }
  learned.endMarket('synthetic');
  learned.freeze();
  assert.equal(learned.spacedCount[metaIndex(1, 2)], 40);
  assert.ok(Math.abs(learned.predict(1, 2) - 2.5) < 1e-12);
  assert.equal(learned.predict(NaN, 2), 2);
  const { tmpdir } = await import('node:os');
  const { readFile, rm } = await import('node:fs/promises');
  const base = await mkdtemp(resolve(tmpdir(), 'forecast-v6-self-test-'));
  const cache = resolve(base, 'source.sqlite');
  const setup = new DatabaseSync(cache);
  setup.exec(`PRAGMA user_version=1;
      CREATE TABLE metadata(key TEXT, value TEXT);
      CREATE TABLE markets(id INTEGER PRIMARY KEY, name TEXT, stock TEXT,
        money TEXT, type TEXT);
      CREATE TABLE observations(market_id INTEGER, received_at INTEGER,
        price REAL, PRIMARY KEY(market_id,received_at)) WITHOUT ROWID;
      INSERT INTO markets VALUES(1,'BTC_USDT','BTC','USDT','spot');`);
  const insert = setup.prepare('INSERT INTO observations VALUES(1,?,?)');
  for (let t = 0; t <= 1_000_000; t += 1000) {
      insert.run(t, 100 * Math.exp(t / 10_000_000) *
        (1 + 0.001 * Math.sin(t / 20_000)));
  }
  setup.prepare(`DELETE FROM observations WHERE received_at>760000
    AND received_at<780000`).run();
  setup.close();
  const db = new DatabaseSync(cache, { readOnly: true });
  try {
    const originalLog = console.log;
    console.log = () => {};
    try {
      const path = resolve(base, 'output');
      await mkdir(path);
      await analyze(db, path);
      const result = JSON.parse(await readFile(resolve(path,
        'comparison.json'), 'utf8'));
      assert.equal(result.version, 6);
      assert.ok(result.coverage.commonValidLabels > 0);
      assert.ok(result.bankStats.derived.ready > 0);
      assert.ok(result.metaFitCoverage.purged > 0);
      const filters = { banks: new SpeedBanks(), ema: new PriceEma() };
      for (const tick of readTicks(db, 1, 0, 700_000)) {
        filters.banks.update(tick.t, tick.p);
        filters.ema.update(tick.t, tick.p);
      }
      const alwaysForecast: Trained[] = MODELS.map((model) => ({
        model, cells: newCells(), quality: new CellQuality(0, 700_000),
        train: new Map<string, TrainCounts>(),
        table: {
          table: new Float64Array(model.stateCount).fill(1),
          factor: new Float64Array(model.stateCount),
          standardError: new Float64Array(model.stateCount),
          effectiveSamples: new Float64Array(model.stateCount),
          pooledVariance: 0, priorVariance: 0,
          meanSamplingVariance: 0, estimatedCells: 0,
        },
      }));
      const labelCheck = new TestStats('BTC_USDT');
      testMarket(db, { id: 1, name: 'BTC_USDT', stock: 'BTC',
        money: 'USDT' }, filters, alwaysForecast, new MetaGrid(),
      700_000, 1_000_000, labelCheck);
      assert.ok(labelCheck.coverage.lateTargets > 0);
      assert.ok(Date.parse(result.baseFitEnd) >
        Date.parse(JSON.parse(await readFile(resolve(path,
          'tau-7000ms/speed-bank/frozen-table.json'), 'utf8'))
          .lastTrainTarget));
      assert.ok(Date.parse(result.metaFitEnd) >
        result.metaFitCoverage.lastTarget);
      const grid = await readFile(resolve(path,
        'tau-7000ms/comparison/speed-bank-vs-derived/forecast-grid.csv'),
      'utf8');
      const gridCount = grid.trim().split('\n').slice(1).reduce((sum, row) =>
        sum + Number(row.split(',')[6].replaceAll('"', '')), 0);
      assert.equal(gridCount, result.coverage.commonValidLabels);
      const byMarket = await readFile(resolve(path,
        'tau-7000ms/comparison/speed-bank-vs-derived/' +
        'forecast-grid-by-market.csv'), 'utf8');
      const marketCount = byMarket.trim().split('\n').slice(1)
        .reduce((sum, row) => sum +
          Number(row.split(',')[7].replaceAll('"', '')), 0);
      assert.equal(marketCount, gridCount);
      const byTime = await readFile(resolve(path,
        'tau-7000ms/comparison/speed-bank-vs-derived/' +
        'forecast-grid-by-time-block.csv'), 'utf8');
      const timeCount = byTime.trim().split('\n').slice(1)
        .reduce((sum, row) => sum +
          Number(row.split(',')[8].replaceAll('"', '')), 0);
      assert.equal(timeCount, gridCount);
      const combined = await readFile(resolve(path,
        'tau-7000ms/comparison/speed-bank-vs-derived/' +
        'combined-comparison.csv'), 'utf8');
      const allCommon = combined.trim().split('\n').slice(1)
        .filter((row) => row.startsWith('"all-common"'));
      assert.equal(allCommon.length, 2);
      for (const row of allCommon) {
        assert.equal(Number(row.split(',')[1].replaceAll('"', '')),
          gridCount);
      }
      const tails = await readFile(resolve(path,
        'tau-7000ms/comparison/speed-bank-vs-derived/' +
        'strong-tail-by-market-time-block.csv'), 'utf8');
      const derivedTail = tails.trim().split('\n').slice(1)
        .filter((row) => row.split(',')[3] === '"speed-bank-derived"')
        .reduce((sum, row) => sum +
          Number(row.split(',')[5].replaceAll('"', '')), 0);
      const bands = await readFile(resolve(path,
        'tau-7000ms/speed-bank-derived/' +
        'forecast-band-calibration.csv'), 'utf8');
      const derivedBand = bands.trim().split('\n').slice(1)
        .filter((row) => {
          const columns = row.split(',').map((x) => x.replaceAll('"', ''));
          return columns[1] === 'ema-residual' &&
            columns[3] === '2.5' && columns[4] === '3';
        })
        .reduce((sum, row) => sum +
          Number(row.split(',')[6].replaceAll('"', '')), 0);
      assert.equal(derivedTail, derivedBand);
      const columns = db.prepare('PRAGMA table_info(observations)').all() as
        { name: string }[];
      assert.deepEqual(columns.map((c) => c.name),
        ['market_id', 'received_at', 'price']);
      assert.throws(() => db.exec('UPDATE observations SET price=0'));
      assert.equal((db.prepare('SELECT count(*) AS n FROM observations')
        .get() as { n: number }).n, 982);
    } finally { console.log = originalLog; }
  } finally { db.close(); await rm(base, { recursive: true, force: true }); }
  console.log('v6 self-test passed');
}

if (process.argv.includes('--self-test')) void selfTest().catch((e) => {
  console.error(e); process.exitCode = 1;
});
else void main().catch((e) => { console.error(e); process.exitCode = 1; });
