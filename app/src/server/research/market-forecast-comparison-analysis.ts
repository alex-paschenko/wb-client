// app/src/server/research/market-forecast-comparison-analysis-v4.ts
// v4: direct 3-tau speed-bank vs derived 4-tau harness from a prepared SQLite cache.
// The derived bank adds a 60s scale but remains 3D: level / contrast / curvature.
// All models use the same empirical-Bayes soft reliability shrinkage.
// Research only: local simulation, no exchange order submission.
// Run from app with node --import tsx; append --self-test for offline tests.
// Edit the constants below; no shell loop or EMA/date environment variables.
// All tau runs share the same cached observations and chronological split.
// Lag diagnostics are retrospective and never feed execution decisions.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const RESEARCH_CACHE_PATH = resolve(
  'research-output/market-research-cache/' +
  'market-research-cache_endedAt-2026-09-27_22-00-12Z.sqlite',
);

const BASE_CURRENCY = 'USDT';
const PRICE_EMA_TAUS_MS: number[] = [10_000, 7_000, 4_000];
// Use null for all available history / automatic 70% training split.
const DATA_END_ISO: string | null = null;
const SPLIT_AT_ISO: string | null = null;
const TEST_START_ISO: string | null = null;
const TEST_END_ISO: string | null = null;

// One common warmup for all tau values; active tau changes sequentially only.
const PRICE_EMA_WARMUP_MS = Math.max(50_000, ...PRICE_EMA_TAUS_MS.map((t) => 5 * t));
let PRICE_EMA_TAU_MS = PRICE_EMA_TAUS_MS[0];
function targetDefinition() { return {
  kind: 'ema-residual-over-constant-price', tauMs: PRICE_EMA_TAU_MS,
  warmupMs: PRICE_EMA_WARMUP_MS,
  formula: '1000 * ln(EMA(target) / Eflat(target-origin))',
  control: 'Eflat(dt)=price(origin)+(EMA(origin)-price(origin))*exp(-dt/tau)',
  targetTime: 'actual first tick at or after origin+60s, at most 10s late',
  meaning: 'EMA return minus its constant-price return; not raw executable return',
  update: 'alpha=-expm1(-dt/tau); E += alpha*(price-E)',
  initialization: 'first valid price per market; common warmup max(50s,5*max(configured taus))',
  gaps: 'continuous time update across gaps; no synthetic ticks or resets',
  featureInput: 'prepared raw [receivedAt,price] cache; both causal speed banks share identical origins; EMA is for labels only',
}; }
// Empty means all cached spot markets quoted in BASE_CURRENCY.
// Example: ['BTC_USDT', 'ETH_USDT']. This affects trading, not training.
const MARKET_NAMES: string[] = [];
const INITIAL_CASH = 1000;
const TRAIN_FRACTION = 0.7;
const HORIZON = 60_000;
const MAX_TARGET_DELAY = 10_000;
const MIN_TRAIN_SAMPLES = integer('MF_MIN_TRAIN_SAMPLES', 30, 1, 1_000_000);
const LATENCY = integer('MF_LATENCY_MS', 250, 0, 60_000);
const MAX_FILL_WAIT = integer('MF_MAX_FILL_WAIT_MS', 2000, 0, 300_000);
const ENTRY_THRESHOLDS = [1, 1.25, 1.5, 1.75, 1.9, 2, 2.25, 2.5, 3];
const ENTRY_BANDS = [
  [1, 1.25], [1.25, 1.5], [1.5, 1.75], [1.75, 1.9], [1.9, 2],
  [2, 2.25], [2.25, 2.5], [2.5, 3], [3, null],
] as const;
const CALIBRATION_THRESHOLDS = [0, ...ENTRY_THRESHOLDS, 4];
const STOP_FRACTION = 0.5;
const FIXED_HOLD_MS = HORIZON;
// Diagnostic thresholds only: they do not suppress strategy entries.
const QUALITY_MIN_SAMPLES = 100;
const ENTRY_MIN_NONOVERLAPPING = 100;
const ENTRY_MIN_SPACED_MEAN_RATIO = 0.5;
const QUALITY_BLOCKS = 3;
const QUALITY_MIN_BLOCK_SAMPLES = 30;
const EQUITY_INTERVAL = 300_000;
const DATA_END = dateSetting(DATA_END_ISO, 'DATA_END_ISO');
const REQUESTED_SPLIT = dateSetting(SPLIT_AT_ISO, 'SPLIT_AT_ISO');
const REQUESTED_START = dateSetting(TEST_START_ISO, 'TEST_START_ISO');
const REQUESTED_END = dateSetting(TEST_END_ISO, 'TEST_END_ISO');
const OUTPUT = resolve('research-output/market-forecast-comparison-v4');
const PAGE = 2048;
const SPEED_BANK_TAUS_MS = [7_000, 15_000, 30_000] as const;
const DERIVED_SPEED_BANK_TAUS_MS = [7_000, 15_000, 30_000, 60_000] as const;
const SPEED_BANK_WARMUP_MS = Math.max(
  50_000,
  ...SPEED_BANK_TAUS_MS.map((tau) => 5 * tau),
);
const DERIVED_SPEED_BANK_WARMUP_MS = Math.max(
  50_000,
  ...DERIVED_SPEED_BANK_TAUS_MS.map((tau) => 5 * tau),
);
// Deliberately asymmetric after alignment to the slow trend sign. Negative
// values are reversal states and are much rarer than positive continuation.
// 14 x 14 x 13 = 2548 states.
const ALIGNED_SPEED_BINS = [
  -3, -1, -0.3, 0, 0.1, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5,
];
const SLOW_SPEED_BINS = [
  0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8,
];
// First-pass curvature bins. v4 writes the train distribution so these can be
// retuned from data without changing tau values.
const SCALE_CURVATURE_BINS = [
  -8, -4, -2, -1, -0.5, -0.2, 0, 0.2, 0.5, 1, 2, 4, 8,
];
const SPEED_BANK_STATE_COUNT = (ALIGNED_SPEED_BINS.length + 1) ** 2 *
  (SLOW_SPEED_BINS.length + 1);
const DERIVED_SPEED_BANK_STATE_COUNT = (ALIGNED_SPEED_BINS.length + 1) *
  (SCALE_CURVATURE_BINS.length + 1) * (SLOW_SPEED_BINS.length + 1);

type ModelId = 'speed-bank' | 'speed-bank-derived';
type ModelConfig = {
  id: ModelId;
  source: string;
  stateCount: number;
  signName: string;
  invalidName: string;
};
const MODELS: readonly ModelConfig[] = [
  { id: 'speed-bank', source: 'speed_bank_observations',
    stateCount: SPEED_BANK_STATE_COUNT, signName: 'slowSpeedSign',
    invalidName: 'invalidBank' },
  { id: 'speed-bank-derived', source: 'speed_bank_derived_observations',
    stateCount: DERIVED_SPEED_BANK_STATE_COUNT, signName: 'slow60SpeedSign',
    invalidName: 'invalidDerivedBank' },
];
let ACTIVE_SOURCE = 'observations';
let ACTIVE_STATE_COUNT = SPEED_BANK_STATE_COUNT;

// All costs below are assumed scenarios, NOT current exchange fee quotes.
// Units: permille, so fee=1 means 0.1% per execution, spread=1 means 0.1% full spread.
const COSTS = [
  { id: 'zero-cost-control', fee: 0, spread: 0, slip: 0 },
  { id: 'fee-only', fee: 1, spread: 0, slip: 0 },
  { id: 'moderate', fee: 1, spread: 0.5, slip: 0.25 },
  { id: 'wide', fee: 1, spread: 2, slip: 0.5 },
];
// Fixed research variants, not selected by test-period profitability.
type Strategy = { id: string; entry: number; entryMax: number | null;
  exit: number | null; exitMode: string;
  targetMode: 'none' | 'threshold' | 'initial-forecast';
  stopPermille: number | null; fixedHoldMs: number | null };
const BASE_STRATEGIES: Strategy[] = ENTRY_THRESHOLDS.flatMap((entry) => [
  { suffix: 'target-threshold', targetMode: 'threshold' as const, exit: null },
  { suffix: 'target-forecast', targetMode: 'initial-forecast' as const, exit: null },
  { suffix: 'forecast-zero', targetMode: 'none' as const, exit: 0 },
  { suffix: 'target-threshold-or-zero', targetMode: 'threshold' as const, exit: 0 },
  { suffix: 'target-forecast-or-zero', targetMode: 'initial-forecast' as const, exit: 0 },
].map(({ suffix, targetMode, exit }) => ({
  id: `entry-${entry}-${suffix}`, entry, entryMax: null, exit, exitMode: suffix,
  targetMode, stopPermille: entry * STOP_FRACTION, fixedHoldMs: null,
})));

const FIXED_HOLD_STRATEGIES: Strategy[] = ENTRY_BANDS.map(([entry, entryMax]) => ({
  id: `band-${entry}-to-${entryMax ?? 'inf'}-fixed-${FIXED_HOLD_MS}ms`,
  entry, entryMax, exit: null, exitMode: 'fixed-hold', targetMode: 'none',
  stopPermille: null, fixedHoldMs: FIXED_HOLD_MS,
}));

// Soft reliability shrinkage replaces the old binary quality-gated strategy
// duplication, keeping the simulation count close to v1.
const STRATEGIES: Strategy[] = [...BASE_STRATEGIES, ...FIXED_HOLD_STRATEGIES];

type Cost = typeof COSTS[number];
type Market = { id: number; name: string; stock: string; money: string };
type Row = { t: number; p: number; cell: number; sign: number; e?: number | null };

function integer(name: string, fallback: number, min: number, max: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name}: expected integer in [${min}, ${max}]`);
  }
  return n;
}

function dateSetting(text: string | null, name: string): number | null {
  if (!text) return null;
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(text)) {
    throw new Error(`${name}: use ISO datetime with explicit timezone`);
  }
  const value = Date.parse(text);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${name}`);
  return value;
}

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

function buildSpeedBanksMarket(db: DatabaseSync, market: number,
  splitAt: number, distribution: DerivedDistribution) {
  const query = db.prepare(`SELECT t,p FROM observations
    WHERE market=? AND t>? ORDER BY t LIMIT ${PAGE}`);
  const update = db.prepare(`UPDATE observations SET
    bank_cell=?, bank_sign=?, derived_bank_cell=?, derived_bank_sign=?
    WHERE market=? AND t=?`);
  const banks = new SpeedBanks();
  const direct: ExtractionStats = { ready: 0, warmup: 0, invalid: 0 };
  const derived: ExtractionStats = { ready: 0, warmup: 0, invalid: 0 };
  let last = -Number.MAX_SAFE_INTEGER;
  for (;;) {
    const rows = query.all(market, last) as Pick<Row, 't' | 'p'>[];
    if (!rows.length) break;
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const state = banks.update(row.t, row.p);
        updateStats(direct, state.direct);
        updateStats(derived, state.derived);
        if (row.t < splitAt && state.derived !== null && state.derived.cell >= 0) {
          observeDerivedDistribution(distribution, state.derived);
        }
        update.run(
          state.direct?.cell ?? -1,
          state.direct?.sign ?? 0,
          state.derived?.cell ?? -1,
          state.derived?.sign ?? 0,
          market,
          row.t,
        );
        last = row.t;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return { direct, derived };
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

function smoothMarket(db: DatabaseSync, market: number,
  fingerprint?: ReturnType<typeof createHash>) {
  const query = db.prepare(`SELECT t,p FROM observations
    WHERE market=? AND t>? ORDER BY t LIMIT ${PAGE}`);
  const update = db.prepare('UPDATE observations SET e=? WHERE market=? AND t=?');
  const ema = new PriceEma();
  let last = -Number.MAX_SAFE_INTEGER;
  let ready = 0;
  let warmup = 0;
  for (;;) {
    const rows = query.all(market, last) as Row[];
    if (!rows.length) break;
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        fingerprint?.update(JSON.stringify([row.t, row.p]) + '\n');
        const e = ema.update(row.t, row.p);
        update.run(e, market, row.t);
        if (e === null) warmup++; else ready++;
        last = row.t;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return { ready, warmup };
}

// Sequential pages keep memory independent of historical market size.
class Reader {
  private page: Row[] = [];
  private index = 0;
  private last = -Number.MAX_SAFE_INTEGER;
  private current: Row | null = null;
  private exhausted = false;
  private previousRequest = -Infinity;
  private readonly query;

  constructor(db: DatabaseSync, market: number, start: number) {
    this.query = db.prepare(`
      SELECT t, p, cell, sign, e FROM ${ACTIVE_SOURCE}
      WHERE market = ? AND t > ? ORDER BY t LIMIT ${PAGE}
    `);
    this.market = market;
    const seed = db.prepare(`
      SELECT t, p, cell, sign, e FROM ${ACTIVE_SOURCE}
      WHERE market = ? AND t <= ? ORDER BY t DESC LIMIT 1
    `).get(market, start) as Row | undefined;
    if (seed) {
      this.current = seed;
      this.last = seed.t;
    }
  }

  private readonly market: number;

  private peek(): Row | null {
    if (this.index === this.page.length) {
      if (this.exhausted) return null;
      this.page = this.query.all(this.market, this.last) as Row[];
      this.index = 0;
      if (!this.page.length) {
        this.exhausted = true;
        return null;
      }
      this.last = this.page[this.page.length - 1].t;
    }
    return this.page[this.index];
  }

  at(time: number): Row | null {
    if (time < this.previousRequest) throw new Error('Nonmonotonic reader');
    this.previousRequest = time;
    for (;;) {
      const next = this.peek();
      if (!next || next.t > time) break;
      this.current = next;
      this.index++;
    }
    return this.current;
  }

  after(time: number): Row | null {
    // Event targets increase and are strictly after the reader seed time.
    this.at(time - 1);
    return this.peek();
  }

}

class Csv {
  constructor(private readonly file: FileHandle) {}
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

function fitMarket(db: DatabaseSync, market: number, first: number,
  splitAt: number, cells: ReturnType<typeof newCells>,
  observe?: (origin: Row, target: Row, alignedReturn: number) => void) {
  const target = new Reader(db, market, first);
  const query = db.prepare(`
    SELECT t, p, cell, sign, e FROM ${ACTIVE_SOURCE}
    WHERE market = ? AND t >= ? AND t < ? ORDER BY t
  `);
  const c = { origins: 0, invalidFeature: 0, purged: 0, noTarget: 0,
    lateTarget: 0, emaUnavailable: 0, accepted: 0, firstOrigin: Infinity, lastOrigin: -Infinity,
    firstTarget: Infinity, lastTarget: -Infinity };
  for (const raw of query.iterate(market, first, splitAt)) {
    const a = raw as Row;
    c.origins++;
    if (a.cell < 0) { c.invalidFeature++; continue; }
    if (a.t + HORIZON >= splitAt) { c.purged++; continue; }
    const b = target.after(a.t + HORIZON);
    if (!b) { c.noTarget++; continue; }
    if (b.t >= splitAt) { c.purged++; continue; }
    if (b.t - a.t - HORIZON > MAX_TARGET_DELAY) {
      c.lateTarget++; continue;
    }
    if (a.e == null || b.e == null) { c.emaUnavailable++; continue; }
    const value = a.sign * residualReturn(a, b);
    const n = ++cells.count[a.cell];
    const delta = value - cells.mean[a.cell];
    cells.mean[a.cell] += delta / n;
    cells.m2[a.cell] += delta * (value - cells.mean[a.cell]);
    observe?.(a, b, value);
    c.accepted++;
    c.firstOrigin = Math.min(c.firstOrigin, a.t);
    c.lastOrigin = Math.max(c.lastOrigin, a.t);
    c.firstTarget = Math.min(c.firstTarget, b.t);
    c.lastTarget = Math.max(c.lastTarget, b.t);
  }
  return c;
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
  constructor(readonly first: number, readonly split: number) {}
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
function entryQualityReasons(cell: number, cells: ReturnType<typeof newCells>,
  quality: CellQuality): string[] {
  const diagnostic = quality.flags(cell, cells);
  const reasons = diagnostic === 'no-listed-flags' ? [] : diagnostic.split('|');
  const mean = cells.mean[cell];
  const spaced = quality.spaced.mean[cell];
  if (quality.spaced.count[cell] < ENTRY_MIN_NONOVERLAPPING) reasons.push('few-nonoverlapping');
  if (!Number.isFinite(mean) || mean === 0 || Math.sign(spaced) !== Math.sign(mean)) {
    reasons.push('nonoverlapping-sign-disagreement');
  } else if (Math.abs(spaced) < ENTRY_MIN_SPACED_MEAN_RATIO * Math.abs(mean)) {
    reasons.push('nonoverlapping-effect-collapse');
  }
  return reasons;
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
async function writeSignalQuality(db: DatabaseSync, market: Market,
  table: Float64Array, cells: ReturnType<typeof newCells>, quality: CellQuality,
  start: number, end: number, csv: Csv) {
  const query = db.prepare(`SELECT t,p,cell,sign,e FROM ${ACTIVE_SOURCE}
    WHERE market=? AND t>=? AND t<=? ORDER BY t`);
  for (const raw of query.iterate(market.id, start, end)) {
    const r = raw as Row;
    const f = r.cell < 0 ? NaN : table[r.cell] * r.sign;
    if (!Number.isFinite(f) || f < Math.min(...ENTRY_THRESHOLDS)) continue;
    await csv.row([market.name, r.t, r.p, r.cell, r.sign, f,
      cells.count[r.cell], quality.spaced.count[r.cell],
      quality.flags(r.cell, cells),
      ...quality.blocks.flatMap((b) => [b.count[r.cell],
        b.count[r.cell] ? b.mean[r.cell] * r.sign : null])]);
  }
}

type Pending = { side: 'buy' | 'sell'; reason: string; t: number;
  due: number; p: number | null; f: number | null };
type OrderEvent = { order: Pending; status: string; at: number;
  reference: number | null; execution: number | null; quantity: number | null;
  fee: number | null; pnl: number | null; holdingMs: number | null };

class Simulation {
  cash = INITIAL_CASH;
  units = 0;
  pending: Pending | null = null;
  first: Row | null = null;
  last: Row | null = null;
  fees = 0;
  turnover = 0;
  buys = 0;
  sells = 0;
  expired = 0;
  unfilledAtEnd = 0;
  wins = 0;
  gains = 0;
  losses = 0;
  closedPnl = 0;
  closedHoldingMs = 0;
  exposedMs = 0;
  peak = INITIAL_CASH;
  maxDrawdown = 0;
  private entryCash = 0;
  private entryAt = 0;
  entryExecutionPrice: number | null = null;
  entryForecast: number | null = null;
  targetPermille: number | null = null;
  targetPrice: number | null = null;
  stopPrice: number | null = null;
  targetExits = 0;
  stopExits = 0;
  forecastExits = 0;
  fixedHoldExits = 0;
  private exitIntent: string | null = null;

  constructor(readonly strategy: Strategy | null, readonly cost: Cost,
    private readonly latency = LATENCY, private readonly wait = MAX_FILL_WAIT) {}

  get id() { return this.strategy?.id ?? 'buy-and-hold'; }
  get buyFactor() { return Math.exp((this.cost.spread / 2 + this.cost.slip) / 1000); }
  get sellFactor() { return 1 / this.buyFactor; }
  get feeRate() { return this.cost.fee / 1000; }

  equity(price: number) {
    // Hypothetical immediate liquidation, not an executed terminal order.
    return this.cash + this.units * price * this.sellFactor * (1 - this.feeRate);
  }

  terminalExitFee(price: number) {
    return this.units * price * this.sellFactor * this.feeRate;
  }

  private mark(price: number) {
    const equity = this.equity(price);
    this.peak = Math.max(this.peak, equity);
    this.maxDrawdown = Math.max(this.maxDrawdown, 1 - equity / this.peak);
  }

  blockedEntries = 0;
  tick(row: Row, forecast: number): OrderEvent | null {
    if (this.last && row.t <= this.last.t) throw new Error('Unordered replay');
    if (!this.first) this.first = row;
    if (this.last && this.units > 0) this.exposedMs += row.t - this.last.t;
    this.last = row;
    this.mark(row.p);

    if (this.pending) {
      const order = this.pending;
      if (row.t > order.due + this.wait) {
        this.pending = null;
        this.expired++;
        return { order, status: 'expired-no-timely-tick', at: row.t,
          reference: row.p, execution: null, quantity: null,
          fee: null, pnl: null, holdingMs: null };
      }
      // Even zero latency must never fill on the signal tick itself.
      if (row.t <= order.t || row.t < order.due) return null;
      this.pending = null;
      const execution = row.p *
        (order.side === 'buy' ? this.buyFactor : this.sellFactor);
      let quantity: number;
      let fee: number;
      let pnl: number | null = null;
      let holdingMs: number | null = null;
      if (order.side === 'buy') {
        assert.equal(this.units, 0);
        const notional = this.cash / (1 + this.feeRate);
        quantity = notional / execution;
        fee = notional * this.feeRate;
        this.entryCash = this.cash;
        this.entryAt = row.t;
        this.entryExecutionPrice = execution;
        this.entryForecast = order.f;
        this.exitIntent = null;
        this.targetPermille = this.strategy?.targetMode === 'threshold'
          ? this.strategy.entry : this.strategy?.targetMode === 'initial-forecast'
            ? order.f : null;
        this.targetPrice = this.targetPermille === null ? null :
          execution * Math.exp(this.targetPermille / 1000);
        this.stopPrice = this.strategy?.stopPermille == null ? null :
          execution * Math.exp(-this.strategy.stopPermille / 1000);
        this.units = quantity;
        this.cash = 0;
        this.buys++;
        this.turnover += notional;
      } else {
        assert.ok(this.units > 0);
        quantity = this.units;
        const notional = quantity * execution;
        fee = notional * this.feeRate;
        this.cash += notional - fee;
        this.units = 0;
        this.sells++;
        if (order.reason.startsWith('target-')) this.targetExits++;
        else if (order.reason === 'protective-stop') this.stopExits++;
        else if (order.reason === 'forecast-faded') this.forecastExits++;
        else if (order.reason === 'fixed-hold') this.fixedHoldExits++;
        this.exitIntent = null;
        this.turnover += notional;
        pnl = this.cash - this.entryCash;
        this.closedPnl += pnl;
        if (pnl > 0) { this.wins++; this.gains += pnl; }
        if (pnl < 0) this.losses -= pnl;
        holdingMs = row.t - this.entryAt;
        this.closedHoldingMs += holdingMs;
      }
      this.fees += fee;
      this.mark(row.p);
      // Do not issue a second order on the same tick as a fill or expiry.
      return { order, status: 'filled', at: row.t, reference: row.p,
        execution, quantity, fee, pnl, holdingMs };
    }
    let side: 'buy' | 'sell' | null = null;
    let reason = '';
    if (this.strategy === null) {
      if (this.units === 0) { side = 'buy'; reason = 'buy-and-hold'; }
    } else if (this.units === 0) {
      if (Number.isFinite(forecast) && forecast >= this.strategy.entry &&
        (this.strategy.entryMax === null || forecast < this.strategy.entryMax)) {
        side = 'buy'; reason = this.strategy.entryMax === null
          ? 'entry-threshold' : 'entry-band';
      }
    } else {
      // Once an exit is triggered, missing execution data must not cancel it.
      // Reissue on a later tick after expiry, even if price/forecast recovers.
      if (this.exitIntent !== null) reason = this.exitIntent;
      else if (this.strategy.fixedHoldMs !== null &&
        row.t >= this.entryAt + this.strategy.fixedHoldMs) {
        reason = 'fixed-hold';
      } else if (this.stopPrice !== null && row.p <= this.stopPrice) {
        reason = 'protective-stop';
      } else if (this.targetPrice !== null && row.p >= this.targetPrice) {
        reason = `target-${this.strategy.targetMode}`;
      } else if (this.strategy.exit !== null && Number.isFinite(forecast) &&
        forecast <= this.strategy.exit) {
        reason = 'forecast-faded';
      }
      if (reason) {
        side = 'sell';
        this.exitIntent = reason;
      }
    }
    if (side) this.pending = { side, reason, t: row.t,
      due: row.t + this.latency, p: row.p,
      f: Number.isFinite(forecast) ? forecast : null };
    return null;
  }

  finish(end: number): OrderEvent | null {

    if (!this.pending) return null;
    const order = this.pending;
    this.pending = null;
    this.unfilledAtEnd++;
    return { order, status: 'unfilled-at-test-end', at: end,
      reference: null, execution: null, quantity: null,
      fee: null, pnl: null, holdingMs: null };
  }

  openPnl(price: number) {
    return this.units > 0 ? this.equity(price) - this.entryCash : 0;
  }

  openHoldingMs() {
    return this.units > 0 && this.last ? this.last.t - this.entryAt : 0;
  }
}

const ORDER_HEADERS = [
  'market', 'strategy', 'costScenario', 'side', 'reason', 'status',
  'signalAt', 'eligibleAt', 'resolvedAt', 'signalForecastPermille',
  'signalPrice', 'referencePrice', 'executionPrice', 'quantity',
  'feeQuote', 'closedPnlQuote', 'holdingMs', 'cashAfter', 'unitsAfter',
  'entryExecutionPrice', 'entryForecastPermille', 'targetPermille',
  'targetPrice', 'stopPrice',
];
const EQUITY_HEADERS = [
  'market', 'strategy', 'costScenario', 'at', 'referencePrice',
  'liquidationEquityQuote', 'cash', 'units', 'executedFeesQuote',
  'estimatedExitFeeQuote', 'forecastPermille',
];
const SUMMARY_HEADERS = [
  'market', 'strategy', 'costScenario', 'horizonMs', 'entryPermille',
  'entryMaxPermille', 'exitPermille', 'exitMode', 'targetMode', 'stopPermille',
  'fixedHoldMs',
  'feePermille', 'fullSpreadPermille', 'slipPerSidePermille',
  'initialCash', 'testTicks', 'validForecastTicks', 'invalidFeatureTicks',
  'missingCellTicks', 'firstTick', 'lastTick', 'terminalPriceAgeMs',
  'buys', 'sells', 'expiredOrders', 'unfilledAtEnd', 'openPosition',
  'closedWins', 'closedWinRate', 'closedProfitFactor', 'closedPnlQuote',
  'openLiquidationPnlQuote', 'finalCash', 'finalUnits',
  'finalLiquidationEquity', 'netReturnPct', 'maxDrawdownPct',
  'buyHoldReturnPct', 'excessOverBuyHoldPctPoints',
  'executedFeesQuote', 'estimatedTerminalExitFeeQuote', 'turnoverQuote',
  'meanClosedHoldingMs', 'openHoldingMs', 'exposureFractionObservedPeriod',
  'targetExits', 'stopExits', 'forecastExits', 'fixedHoldExits',
  'qualityBlockedEntryTicks',
];

// Fixed-size aggregation: never reread large order or summary files.
class OrdersSummary {
  private readonly sums = new Map<string, { sum: number; count: number }>();
  add(tau: number, strategy: string, cost: string, roi: number | null) {
    if (roi === null) return;
    assert.ok(Number.isFinite(roi));
    const key = `${tau}/${strategy}/${cost}`;
    const item = this.sums.get(key) ?? { sum: 0, count: 0 };
    item.sum += roi;
    item.count++;
    this.sums.set(key, item);
  }
  async write(path: string, taus: number[]) {
    const columns = taus.flatMap((tau) => COSTS.map((cost) => ({ tau, cost: cost.id })));
    const csv = await Csv.create(path, ['strategy', ...columns.map(({ tau, cost }) =>
      `tau_${tau}ms_${cost}_netReturnPct`)]);
    try {
      for (const strategy of [...STRATEGIES.map((s) => s.id), 'buy-and-hold']) {
        await csv.row([strategy, ...columns.map(({ tau, cost }) => {
          const item = this.sums.get(`${tau}/${strategy}/${cost}`);
          return item ? item.sum / item.count : null;
        })]);
      }
    } finally { await csv.close(); }
  }
}

async function writeOrder(csv: Csv, market: string, s: Simulation, e: OrderEvent) {
  await csv.row([market, s.id, s.cost.id, e.order.side, e.order.reason, e.status,
    e.order.t, e.order.due, e.at, e.order.f, e.order.p, e.reference,
    e.execution, e.quantity, e.fee, e.pnl, e.holdingMs, s.cash, s.units,
    ...((e.order.side === 'sell' || e.status === 'filled')
      ? [s.entryExecutionPrice, s.entryForecast, s.targetPermille, s.targetPrice, s.stopPrice]
      : [null, null, null, null, null])]);
}

async function writeEquity(csv: Csv, market: string, s: Simulation, f: number) {
  if (!s.last) return;
  await csv.row([market, s.id, s.cost.id, s.last.t, s.last.p,
    s.equity(s.last.p), s.cash, s.units, s.fees,
    s.terminalExitFee(s.last.p), f]);
}

async function replay(db: DatabaseSync, market: Market, table: Float64Array,
  start: number, end: number, summary: Csv, orders: Csv, equity: Csv,
  onOrder?: (s: Simulation, e: OrderEvent) => void,
  onResult?: (s: Simulation, roi: number | null) => void) {
  const simulations = COSTS.flatMap((cost) =>
    [...STRATEGIES, null].map((strategy) => new Simulation(strategy, cost)));
  const query = db.prepare(`
    SELECT t, p, cell, sign, e FROM ${ACTIVE_SOURCE}
    WHERE market = ? AND t >= ? AND t <= ? ORDER BY t
  `);
  let ticks = 0;
  let valid = 0;
  let invalid = 0;
  let missing = 0;
  let nextEquity = start;
  let lastEquityAt = -Infinity;
  let lastForecast = NaN;
  for (const raw of query.iterate(market.id, start, end)) {
    const row = raw as Row;
    ticks++;
    const f = row.cell < 0 ? NaN : table[row.cell] * row.sign;
    lastForecast = f;
    if (row.cell < 0) invalid++;
    else if (!Number.isFinite(f)) missing++;
    else valid++;
    for (const s of simulations) {
      const event = s.tick(row, f);
      if (event) {
        onOrder?.(s, event);
        await writeOrder(orders, market.name, s, event);
      }
    }
    if (row.t >= nextEquity) {
      for (const s of simulations) await writeEquity(equity, market.name, s, f);
      lastEquityAt = row.t;
      nextEquity = Math.floor(row.t / EQUITY_INTERVAL) * EQUITY_INTERVAL +
        EQUITY_INTERVAL;
    }
  }
  for (const s of simulations) {
    const event = s.finish(end);
    if (event) {
      onOrder?.(s, event);
      await writeOrder(orders, market.name, s, event);
    }
    if (s.last && s.last.t !== lastEquityAt) {
      await writeEquity(equity, market.name, s, lastForecast);
    }
    const price = s.last?.p;
    const final = price === undefined ? null : s.equity(price);
    const netReturn = final === null ? null : 100 * (final / INITIAL_CASH - 1);
    onResult?.(s, netReturn);
    const baseline = simulations.find((b) => b.cost.id === s.cost.id &&
      b.strategy === null)!;
    const baselineReturn = price === undefined ? null :
      100 * (baseline.equity(price) / INITIAL_CASH - 1);
    const elapsed = s.last && s.first ? s.last.t - s.first.t : 0;
    await summary.row([
      market.name, s.id, s.cost.id, HORIZON, s.strategy?.entry,
      s.strategy?.entryMax, s.strategy?.exit, s.strategy?.exitMode ?? 'buy-and-hold',
      s.strategy?.targetMode, s.strategy?.stopPermille, s.strategy?.fixedHoldMs,
      s.cost.fee, s.cost.spread, s.cost.slip,
      INITIAL_CASH, ticks, valid, invalid, missing, s.first?.t, s.last?.t,
      s.last ? end - s.last.t : null,
      s.buys, s.sells, s.expired, s.unfilledAtEnd, s.units > 0,
      s.wins, s.sells ? s.wins / s.sells : null,
      s.losses ? s.gains / s.losses : null, s.closedPnl,
      price === undefined ? null : s.openPnl(price), s.cash, s.units,
      final, netReturn, ticks ? s.maxDrawdown * 100 : null,
      baselineReturn, netReturn === null || baselineReturn === null
        ? null : netReturn - baselineReturn,
      s.fees, price === undefined ? null : s.terminalExitFee(price), s.turnover,
      s.sells ? s.closedHoldingMs / s.sells : null, s.openHoldingMs(),
      elapsed ? s.exposedMs / elapsed : null,
      s.targetExits, s.stopExits, s.forecastExits, s.fixedHoldExits, s.blockedEntries,
    ]);
  }
}
// Retrospective labels are calculated only after replay; they never feed decisions.
const LABEL_STATUSES = ['valid', 'horizon-after-end', 'no-target', 'late-target'] as const;
type LabelStatus = typeof LABEL_STATUSES[number];
type Label = { status: LabelStatus; row: Row | null };
function labelAt(candidate: Row | null, due: number, end: number): Label {
  if (due > end) return { status: 'horizon-after-end', row: null };
  if (!candidate || candidate.t > end) return { status: 'no-target', row: null };
  assert.ok(candidate.t >= due);
  if (candidate.t - due > MAX_TARGET_DELAY) {
    return { status: 'late-target', row: candidate };
  }
  return { status: 'valid', row: candidate };
}
const logReturn = (from: number, to: number) => 1000 * Math.log(to / from);
function components(signal: number, fill: number, signalTarget: number, fillTarget: number) {
  const whole = logReturn(signal, signalTarget);
  const beforeFill = logReturn(signal, fill);
  const remaining = logReturn(fill, signalTarget);
  const afterFill = logReturn(fill, fillTarget);
  const endpointShift = logReturn(signalTarget, fillTarget);
  assert.ok(Math.abs(whole - beforeFill - remaining) < 1e-8);
  assert.ok(Math.abs(afterFill - remaining - endpointShift) < 1e-8);
  return [whole, beforeFill, remaining, afterFill, endpointShift];
}
const DIAGNOSTIC_HEADERS = [
  'market', 'cohort', 'strategy', 'entryThreshold', 'orderStatus', 'samples',
  'validSignalTargets', 'horizonAfterEnd', 'noTarget', 'lateTarget',
  'meanForecastValid', 'meanSignalToTargetPermille', 'meanActualMinusForecastPermille',
  'positiveTargetFraction', 'commonSamples', 'meanForecastCommon',
  'meanSignalToTargetCommonPermille', 'meanSignalToFillCommonPermille',
  'meanFillToSignalTargetCommonPermille', 'meanFillToFillTargetCommonPermille',
  'meanEndpointShiftCommonPermille', 'meanFillDelayCommonMs',
];
const ATTEMPT_HEADERS = [
  'market', 'strategy', 'entryThreshold', 'orderStatus', 'signalAt', 'signalPrice',
  'forecast', 'resolvedAt', 'fillAt', 'fillReferencePrice', 'fillDelayMs',
  'signalTargetStatus', 'signalTargetAt', 'signalTargetPrice', 'signalTargetDelayMs',
  'fillTargetStatus', 'fillTargetAt', 'fillTargetPrice', 'fillTargetDelayMs',
  'commonSample', 'signalToTargetPermille', 'signalToFillPermille',
  'fillToSignalTargetPermille', 'fillToFillTargetPermille', 'endpointShiftPermille',
];
class DiagnosticGroup {
  samples = 0;
  counts = [0, 0, 0, 0];
  forecast = 0;
  actual = 0;
  positive = 0;
  common = 0;
  commonForecast = 0;
  sums = [0, 0, 0, 0, 0];
  delay = 0;
  add(f: number, price: number, label: Label) {
    this.samples++;
    this.counts[LABEL_STATUSES.indexOf(label.status)]++;
    if (label.status === 'valid') {
      const actual = logReturn(price, label.row!.p);
      this.forecast += f;
      this.actual += actual;
      this.positive += Number(actual > 0);
    }
  }
  addCommon(f: number, values: number[], delay: number) {
    this.common++;
    this.commonForecast += f;
    values.forEach((v, i) => { this.sums[i] += v; });
    this.delay += delay;
  }
  async write(csv: Csv, market: string, cohort: string, strategy: string,
    threshold: number, status: string) {
    const mean = (sum: number, n: number) => n ? sum / n : null;
    await csv.row([market, cohort, strategy, threshold, status, this.samples,
      ...this.counts, mean(this.forecast, this.counts[0]),
      mean(this.actual, this.counts[0]), mean(this.actual - this.forecast, this.counts[0]),
      mean(this.positive, this.counts[0]), this.common,
      mean(this.commonForecast, this.common),
      ...this.sums.map((v) => mean(v, this.common)), mean(this.delay, this.common)]);
  }
}
function attemptRecorder(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS buy_attempts (
    strategy TEXT, threshold REAL, status TEXT, signalAt INTEGER, signalPrice REAL,
    forecast REAL, resolvedAt INTEGER, fillPrice REAL
  )`);
  const insert = db.prepare('INSERT INTO buy_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  return (s: Simulation, e: OrderEvent) => {
    if (!s.strategy || s.cost.id !== 'zero-cost-control' || e.order.side !== 'buy') return;
    assert.ok(e.order.p !== null && e.order.f !== null);
    insert.run(s.id, s.strategy.entry, e.status, e.order.t, e.order.p,
      e.order.f, e.at, e.status === 'filled' ? e.reference : null);
  };
}
type Attempt = { strategy: string; threshold: number; status: string;
  signalAt: number; signalPrice: number; forecast: number; resolvedAt: number;
  fillPrice: number | null };
async function diagnostics(db: DatabaseSync, market: Market, table: Float64Array,
  start: number, end: number, summary: Csv, attempts: Csv) {
  const thresholds = [...new Set(STRATEGIES.map((s) => s.entry))];
  const groups = thresholds.map(() => new DiagnosticGroup());
  const reader = new Reader(db, market.id, start - 1);
  const ticks = db.prepare(`SELECT t,p,cell,sign,e FROM ${ACTIVE_SOURCE}
    WHERE market=? AND t>=? AND t<=? ORDER BY t`);
  for (const raw of ticks.iterate(market.id, start, end)) {
    const r = raw as Row;
    const f = r.cell < 0 ? NaN : table[r.cell] * r.sign;
    if (!Number.isFinite(f) || !thresholds.some((v) => f >= v)) continue;
    const due = r.t + HORIZON;
    const label = labelAt(due > end ? null : reader.after(due), due, end);
    thresholds.forEach((threshold, i) => {
      if (f >= threshold) groups[i].add(f, r.p, label);
    });
  }
  for (const [i, threshold] of thresholds.entries()) {
    await groups[i].write(summary, market.name, 'all-positive-ticks', '', threshold, '');
  }
  const lookup = db.prepare(`SELECT t,p,cell,sign,e FROM ${ACTIVE_SOURCE}
    WHERE market=? AND t>=? AND t<=? ORDER BY t LIMIT 1`);
  const target = (due: number) => labelAt(due > end ? null :
    (lookup.get(market.id, due, end) as Row | undefined) ?? null, due, end);
  const selected = new Map<string, { group: DiagnosticGroup; attempt: Attempt }>();
  for (const raw of db.prepare('SELECT * FROM buy_attempts').iterate()) {
    const a = raw as Attempt;
    const signal = target(a.signalAt + HORIZON);
    const filled = a.status === 'filled';
    const fill = filled ? target(a.resolvedAt + HORIZON) : null;
    const key = `${a.strategy}/${a.status}`;
    let aggregate = selected.get(key);
    if (!aggregate) {
      aggregate = { group: new DiagnosticGroup(), attempt: a };
      selected.set(key, aggregate);
    }
    aggregate.group.add(a.forecast, a.signalPrice, signal);
    const common = filled && signal.status === 'valid' && fill?.status === 'valid';
    if (common) {
      aggregate.group.addCommon(a.forecast, components(a.signalPrice, a.fillPrice!,
        signal.row!.p, fill!.row!.p), a.resolvedAt - a.signalAt);
    }
    await attempts.row([market.name, a.strategy, a.threshold, a.status,
      a.signalAt, a.signalPrice, a.forecast, a.resolvedAt,
      filled ? a.resolvedAt : null, a.fillPrice,
      filled ? a.resolvedAt - a.signalAt : null,
      signal.status, signal.row?.t, signal.row?.p,
      signal.row ? signal.row.t - a.signalAt - HORIZON : null,
      fill?.status, fill?.row?.t, fill?.row?.p,
      fill?.row ? fill.row.t - a.resolvedAt - HORIZON : null, common,
      signal.status === 'valid' ? logReturn(a.signalPrice, signal.row!.p) : null,
      filled ? logReturn(a.signalPrice, a.fillPrice!) : null,
      filled && signal.status === 'valid' ? logReturn(a.fillPrice!, signal.row!.p) : null,
      fill?.status === 'valid' ? logReturn(a.fillPrice!, fill.row!.p) : null,
      common ? logReturn(signal.row!.p, fill!.row!.p) : null]);
  }
  for (const { group, attempt: a } of selected.values()) {
    await group.write(summary, market.name, 'buy-attempts', a.strategy, a.threshold, a.status);
  }
}

// The constant-price control is known at the origin for a fixed horizon.
function constantPriceEma(price: number, ema: number, elapsed: number) {
  return price + (ema - price) * Math.exp(-elapsed / PRICE_EMA_TAU_MS);
}
function residualReturn(a: Row, b: Row) {
  assert.ok(a.e != null && b.e != null);
  return logReturn(constantPriceEma(a.p, a.e, b.t - a.t), b.e);
}
function lagMetrics(a: Row, b: Row, forecast: number) {
  assert.ok(a.e != null && b.e != null);
  const flat60 = constantPriceEma(a.p, a.e, HORIZON);
  const flatTarget = constantPriceEma(a.p, a.e, b.t - a.t);
  const rawReturn = logReturn(a.p, b.p);
  const emaReturn = logReturn(a.e, b.e);
  const originGap = logReturn(a.e, a.p);
  const targetGap = logReturn(b.e, b.p);
  const constant60 = logReturn(a.e, flat60);
  const constantTarget = logReturn(a.e, flatTarget);
  const residual = residualReturn(a, b);
  return { rawReturn, emaReturn, originGap, targetGap, constant60,
    constantTarget, residual,
    reconstructedEmaForecast: forecast + constant60,
    forecastError: forecast - residual,
    baselineError: -residual, flat60, flatTarget };
}
const LAG_KEYS = ['rawReturn', 'emaReturn', 'originGap', 'targetGap',
  'constant60', 'constantTarget', 'residual', 'reconstructedEmaForecast'] as const;
const LAG_SUMMARY_HEADERS = [
  'market', 'direction', 'absForecastThreshold', 'validTargets',
  'meanForecastPermille',
  ...LAG_KEYS.map((key) => `mean_${key}_permille`),
  'residualForecastMAEPermille', 'zeroResidualMAEPermille',
  'residualForecastRMSEPermille', 'zeroResidualRMSEPermille',
  'reconstructedEmaCorrectDirection', 'meanTargetDelayMs',
];
const LAG_SIGNAL_HEADERS = [
  'market', 'signalAt', 'targetAt', 'targetDelayMs', 'cell', 'featureSign',
  'forecastPermille', 'priceOrigin', 'emaOrigin', 'priceTarget', 'emaTarget',
  'constantPriceEma60s', 'constantPriceEmaAtTarget',
  ...LAG_KEYS.map((key) => `${key}Permille`),
];

const CALIBRATION_HEADERS = [
  'market', 'priceBasis', 'direction', 'absForecastThreshold', 'samples', 'validTargets',
  'horizonAfterEnd', 'noTarget', 'lateTarget', 'emaUnavailable', 'meanForecastPermille',
  'meanActualPermille', 'meanDirectionalReturnPermille', 'correctDirection',
  'wrongDirection', 'flat', 'directionAccuracy',
];
async function calibrate(db: DatabaseSync, market: Market, table: Float64Array,
  start: number, end: number, csv: Csv, basis: 'ema-residual' | 'raw',
  lagSummary?: Csv, lagSignals?: Csv) {
  const groups = [-1, 1].flatMap((sign) => CALIBRATION_THRESHOLDS.map(
    (threshold) => ({ sign, threshold, samples: 0, counts: [0, 0, 0, 0],
      unavailable: 0, forecast: 0, actual: 0, correct: 0, wrong: 0, flat: 0,
      lag: new Float64Array(LAG_KEYS.length), forecastAbs: 0, baselineAbs: 0,
      forecastSq: 0, baselineSq: 0, baselineCorrect: 0, delay: 0 })));
  const reader = new Reader(db, market.id, start - 1);
  const query = db.prepare(`SELECT t,p,cell,sign,e FROM ${ACTIVE_SOURCE}
    WHERE market=? AND t>=? AND t<=? ORDER BY t`);
  for (const raw of query.iterate(market.id, start, end)) {
    const r = raw as Row;
    const f = r.cell < 0 ? NaN : table[r.cell] * r.sign;
    if (!Number.isFinite(f) || f === 0) continue;
    const due = r.t + HORIZON;
    const label = labelAt(due > end ? null : reader.after(due), due, end);
    const lm = basis === 'ema-residual' && label.status === 'valid' &&
      r.e != null && label.row!.e != null ? lagMetrics(r, label.row!, f) : null;
    if (lm && lagSignals && Math.abs(f) >= Math.min(...ENTRY_THRESHOLDS)) {
      const b = label.row!;
      await lagSignals.row([market.name, r.t, b.t, b.t - due, r.cell, r.sign,
        f, r.p, r.e, b.p, b.e, lm.flat60, lm.flatTarget,
        ...LAG_KEYS.map((key) => lm[key])]);
    }
    for (const g of groups) {
      if (Math.sign(f) !== g.sign || Math.abs(f) < g.threshold) continue;
      g.samples++;
      if (label.status === 'valid' && (r.e == null || label.row!.e == null)) {
        g.unavailable++;
        continue;
      }
      g.counts[LABEL_STATUSES.indexOf(label.status)]++;
      if (label.status !== 'valid') continue;
      const actual = basis === 'ema-residual' ? residualReturn(r, label.row!) :
        logReturn(r.p, label.row!.p);
      g.forecast += f;
      g.actual += actual;
      g.correct += Number(actual * g.sign > 0);
      g.wrong += Number(actual * g.sign < 0);
      g.flat += Number(actual === 0);
      if (lm) {
        LAG_KEYS.forEach((key, i) => { g.lag[i] += lm[key]; });
        g.forecastAbs += Math.abs(lm.forecastError);
        g.baselineAbs += Math.abs(lm.baselineError);
        g.forecastSq += lm.forecastError ** 2;
        g.baselineSq += lm.baselineError ** 2;
        g.baselineCorrect += Number(lm.reconstructedEmaForecast * lm.emaReturn > 0);
        g.delay += label.row!.t - due;
      }
    }
  }
  for (const g of groups) {
    const n = g.counts[0];
    await csv.row([market.name, basis, g.sign > 0 ? 'up' : 'down', g.threshold,
      g.samples, ...g.counts, g.unavailable, n ? g.forecast / n : null,
      n ? g.actual / n : null, n ? g.actual * g.sign / n : null,
      g.correct, g.wrong, g.flat, n ? g.correct / n : null]);
    if (basis === 'ema-residual' && lagSummary) {
      await lagSummary.row([market.name, g.sign > 0 ? 'up' : 'down', g.threshold,
        n, n ? g.forecast / n : null,
        ...Array.from(g.lag, (v) => n ? v / n : NaN),
        n ? g.forecastAbs / n : null, n ? g.baselineAbs / n : null,
        n ? Math.sqrt(g.forecastSq / n) : null,
        n ? Math.sqrt(g.baselineSq / n) : null,
        g.baselineCorrect, n ? g.delay / n : null]);
    }
  }
}

const FORECAST_BAND_HEADERS = [
  'market', 'priceBasis', 'direction', 'absForecastMinInclusive',
  'absForecastMaxExclusive', 'samples', 'validTargets', 'horizonAfterEnd',
  'noTarget', 'lateTarget', 'emaUnavailable', 'meanForecastPermille',
  'meanActualPermille', 'meanDirectionalReturnPermille', 'correctDirection',
  'wrongDirection', 'flat', 'directionAccuracy',
];

async function calibrateBands(db: DatabaseSync, market: Market,
  table: Float64Array, start: number, end: number, csv: Csv,
  basis: 'ema-residual' | 'raw') {
  const groups = [-1, 1].flatMap((sign) => ENTRY_BANDS.map(([min, max]) => ({
    sign, min, max, samples: 0, counts: [0, 0, 0, 0], unavailable: 0,
    forecast: 0, actual: 0, correct: 0, wrong: 0, flat: 0,
  })));
  const reader = new Reader(db, market.id, start - 1);
  const query = db.prepare(`SELECT t,p,cell,sign,e FROM ${ACTIVE_SOURCE}
    WHERE market=? AND t>=? AND t<=? ORDER BY t`);
  for (const raw of query.iterate(market.id, start, end)) {
    const r = raw as Row;
    const f = r.cell < 0 ? NaN : table[r.cell] * r.sign;
    if (!Number.isFinite(f) || f === 0) continue;
    const abs = Math.abs(f);
    const g = groups.find((item) => item.sign === Math.sign(f) &&
      abs >= item.min && (item.max === null || abs < item.max));
    if (!g) continue;
    g.samples++;
    const due = r.t + HORIZON;
    const label = labelAt(due > end ? null : reader.after(due), due, end);
    if (label.status === 'valid' && (r.e == null || label.row!.e == null)) {
      g.unavailable++;
      continue;
    }
    g.counts[LABEL_STATUSES.indexOf(label.status)]++;
    if (label.status !== 'valid') continue;
    const actual = basis === 'ema-residual' ? residualReturn(r, label.row!) :
      logReturn(r.p, label.row!.p);
    g.forecast += f;
    g.actual += actual;
    g.correct += Number(actual * g.sign > 0);
    g.wrong += Number(actual * g.sign < 0);
    g.flat += Number(actual === 0);
  }
  for (const g of groups) {
    const n = g.counts[0];
    await csv.row([market.name, basis, g.sign > 0 ? 'up' : 'down', g.min, g.max,
      g.samples, ...g.counts, g.unavailable, n ? g.forecast / n : null,
      n ? g.actual / n : null, n ? g.actual * g.sign / n : null,
      g.correct, g.wrong, g.flat, n ? g.correct / n : null]);
  }
}

type ModelRunResult = {
  model: ModelConfig;
  table: Float64Array;
  trainSamples: number;
  lastTrainTarget: number;
  tableSha256: string;
};

const COMMON_COMPARE_THRESHOLDS = ENTRY_THRESHOLDS;
const COMMON_PAIR_MIN_ABS_FORECAST = 1;

type PairAggregate = {
  count: number;
  leftForecast: number;
  rightForecast: number;
  residual: number;
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

type ModelColumns = {
  cell: 'bank_cell' | 'derived_bank_cell';
  sign: 'bank_sign' | 'derived_bank_sign';
};

const MODEL_COLUMNS: Record<ModelId, ModelColumns> = {
  'speed-bank': { cell: 'bank_cell', sign: 'bank_sign' },
  'speed-bank-derived': {
    cell: 'derived_bank_cell',
    sign: 'derived_bank_sign',
  },
};

function newPairAggregate(): PairAggregate {
  return {
    count: 0,
    leftForecast: 0,
    rightForecast: 0,
    residual: 0,
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

async function compareModelPair(db: DatabaseSync, markets: readonly Market[],
  left: ModelRunResult, right: ModelRunResult, start: number, end: number,
  directory: string) {
  await mkdir(directory, { recursive: true });
  const summary = await Csv.create(resolve(directory, 'common-comparison.csv'), [
    'cohort', 'samples', 'leftModel', 'rightModel',
    'meanLeftForecastPermille', 'meanRightForecastPermille',
    'meanActualResidualPermille', 'meanRawReturnPermille',
    'meanLeftDirectionalResidualPermille', 'meanRightDirectionalResidualPermille',
    'meanLeftDirectionalRawPermille', 'meanRightDirectionalRawPermille',
    'leftResidualDirectionAccuracy', 'rightResidualDirectionAccuracy',
    'leftRawDirectionAccuracy', 'rightRawDirectionAccuracy',
    'leftMAEPermille', 'rightMAEPermille', 'leftRMSEPermille', 'rightRMSEPermille',
  ]);
  const pairs = await Csv.create(resolve(directory, 'forecast-pairs.csv'), [
    'market', 'originAt', 'targetAt', 'targetDelayMs', 'leftModel', 'rightModel',
    'leftCell', 'leftSign', 'leftForecastPermille',
    'rightCell', 'rightSign', 'rightForecastPermille',
    'actualResidualPermille', 'rawReturnPermille', 'sameForecastSign',
  ]);
  const aggregates = new Map<string, PairAggregate>();
  let commonValid = 0;
  let pairRows = 0;
  const leftColumns = MODEL_COLUMNS[left.model.id];
  const rightColumns = MODEL_COLUMNS[right.model.id];
  const query = db.prepare(`
    SELECT t,p,e,
      ${leftColumns.cell} AS left_cell,
      ${leftColumns.sign} AS left_sign,
      ${rightColumns.cell} AS right_cell,
      ${rightColumns.sign} AS right_sign
    FROM observations WHERE market=? AND t>=? AND t<=? ORDER BY t
  `);
  ACTIVE_SOURCE = 'target_observations';
  for (const market of markets) {
    const target = new Reader(db, market.id, start - 1);
    for (const raw of query.iterate(market.id, start, end)) {
      const r = raw as {
        t: number;
        p: number;
        e: number | null;
        left_cell: number;
        left_sign: number;
        right_cell: number;
        right_sign: number;
      };
      if (r.left_cell < 0 || r.right_cell < 0) continue;
      const lf0 = left.table[r.left_cell];
      const rf0 = right.table[r.right_cell];
      if (!Number.isFinite(lf0) || !Number.isFinite(rf0)) continue;
      const leftForecast = lf0 * r.left_sign;
      const rightForecast = rf0 * r.right_sign;
      if (!Number.isFinite(leftForecast) || !Number.isFinite(rightForecast) ||
        leftForecast === 0 || rightForecast === 0) continue;
      const due = r.t + HORIZON;
      const label = labelAt(due > end ? null : target.after(due), due, end);
      if (label.status !== 'valid' || r.e == null || label.row!.e == null) continue;
      const origin: Row = { t: r.t, p: r.p, cell: 0, sign: 0, e: r.e };
      const residual = residualReturn(origin, label.row!);
      const rawReturn = logReturn(r.p, label.row!.p);
      commonValid++;
      for (const cohort of pairCohorts(leftForecast, rightForecast,
        left.model.id, right.model.id)) {
        const g = aggregates.get(cohort) ?? newPairAggregate();
        observePair(g, leftForecast, rightForecast, residual, rawReturn);
        aggregates.set(cohort, g);
      }
      if (Math.max(Math.abs(leftForecast), Math.abs(rightForecast)) >=
        COMMON_PAIR_MIN_ABS_FORECAST) {
        pairRows++;
        await pairs.row([
          market.name,
          r.t,
          label.row!.t,
          label.row!.t - due,
          left.model.id,
          right.model.id,
          r.left_cell,
          r.left_sign,
          leftForecast,
          r.right_cell,
          r.right_sign,
          rightForecast,
          residual,
          rawReturn,
          Math.sign(leftForecast) === Math.sign(rightForecast),
        ]);
      }
    }
  }
  try {
    const names = [
      'all-common',
      ...COMMON_COMPARE_THRESHOLDS.flatMap((threshold) => [
        `both>=${threshold}`,
        `both>=${threshold}-same-sign`,
        `both>=${threshold}-opposite-sign`,
        `${left.model.id}-only>=${threshold}`,
        `${right.model.id}-only>=${threshold}`,
      ]),
    ];
    for (const name of names) {
      const g = aggregates.get(name);
      if (!g?.count) continue;
      const n = g.count;
      await summary.row([
        name,
        n,
        left.model.id,
        right.model.id,
        g.leftForecast / n,
        g.rightForecast / n,
        g.residual / n,
        g.raw / n,
        g.leftDirectional / n,
        g.rightDirectional / n,
        g.leftRawDirectional / n,
        g.rightRawDirectional / n,
        g.leftCorrect / n,
        g.rightCorrect / n,
        g.leftRawCorrect / n,
        g.rightRawCorrect / n,
        g.leftAbsError / n,
        g.rightAbsError / n,
        Math.sqrt(g.leftSquaredError / n),
        Math.sqrt(g.rightSquaredError / n),
      ]);
    }
  } finally {
    await summary.close();
    await pairs.close();
  }
  await writeFile(resolve(directory, 'common-comparison.json'), JSON.stringify({
    leftModel: left.model.id,
    rightModel: right.model.id,
    commonValidLabels: commonValid,
    forecastPairRows: pairRows,
    pairRowFilter:
      `max(abs(leftForecast),abs(rightForecast)) >= ${COMMON_PAIR_MIN_ABS_FORECAST}`,
    comparisonThresholds: COMMON_COMPARE_THRESHOLDS,
    note: 'Both models use the same origin, actual selected target tick and target EMA.',
  }, null, 2) + '\n');
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

async function runModel(db: DatabaseSync, model: ModelConfig,
  markets: readonly Market[], selected: readonly Market[], range: {
    first: number; last: number; n: number }, splitAt: number, start: number, end: number,
  directory: string, observationsSha256: string,
  cacheMetadata: Record<string, string>, emaReady: number, emaWarmup: number,
  bankStats: SpeedBankExtractionStats,
  returns: OrdersSummary, started: number): Promise<ModelRunResult> {
  ACTIVE_SOURCE = model.source;
  ACTIVE_STATE_COUNT = model.stateCount;
  await mkdir(directory, { recursive: true });
  const files: Csv[] = [];
  async function output(name: string, headers: string[]) {
    const csv = await Csv.create(resolve(directory, name), headers);
    files.push(csv);
    return csv;
  }
  try {
    const trainCoverage = await output('training.csv', [
      'market', 'origins', model.invalidName, 'purged', 'noTarget', 'lateTarget',
      'emaUnavailable', 'accepted', 'firstOrigin', 'lastOrigin', 'firstTarget', 'lastTarget',
    ]);
    const cells = newCells();
    const quality = new CellQuality(range.first, splitAt);
    let trainSamples = 0;
    let lastTrainTarget = -Infinity;
    for (const market of markets) {
      quality.beginMarket();
      const c = fitMarket(db, market.id, range.first, splitAt, cells,
        (a, b, value) => quality.observe(a, b, value));
      quality.endMarket(market.name);
      trainSamples += c.accepted;
      lastTrainTarget = Math.max(lastTrainTarget, c.lastTarget);
      await trainCoverage.row([market.name, ...Object.values(c)]);
      console.log(`${model.id} training: ${market.name}, samples=${c.accepted}`);
    }
    const reliability = buildSoftReliability(cells, quality);
    const table = reliability.table;
    if (!table.some(Number.isFinite)) throw new Error(`${model.id}: no usable trained cells`);
    assert.ok(lastTrainTarget < splitAt);
    const cellQuality = await output('cell-quality.csv', [
      'cell', 'forecastEnabled', 'trainSamples', 'rawAlignedMeanPermille',
      'shrunkAlignedForecastPermille', 'softReliability', 'effectiveSamples',
      'standardErrorPermille', 'sampleStdDevPermille',
      'minPermille', 'maxPermille', 'positiveFraction',
      'trainingMarkets', 'largestMarket', 'largestMarketSampleShare',
      'nonOverlappingSamples', 'nonOverlappingAlignedMeanPermille',
      'nonOverlappingStdDevPermille', 'blockBoundaryPurged', 'flags',
    ]);
    const blockQuality = await output('cell-time-blocks.csv', [
      'cell', 'block', 'startInclusive', 'endExclusive', 'samples',
      'alignedMeanPermille', 'sampleStdDevPermille', 'enoughBlockSamples',
    ]);
    await writeQuality(quality, cells, reliability, cellQuality, blockQuality);
    const signalQuality = await output('signal-quality.csv', [
      'market', 'signalAt', 'signalPrice', 'cell', model.signName, 'forecastPermille',
      'trainSamples', 'nonOverlappingSamples', 'flags',
      ...Array.from({ length: QUALITY_BLOCKS }, (_, i) =>
        [`block${i + 1}Samples`, `block${i + 1}NaturalMeanPermille`]).flat(),
    ]);
    const frozen = JSON.stringify({
      version: 4, model: model.id, source: 'prepared SQLite research cache, chronological training',
      observationsSha256, targetDefinition: targetDefinition(), horizonMs: HORIZON,
      splitAt: new Date(splitAt).toISOString(), trainSamples,
      lastTrainTarget: new Date(lastTrainTarget).toISOString(),
      minTrainSamples: MIN_TRAIN_SAMPLES, stateCount: model.stateCount,
      trainingMarkets: markets, tradingMarkets: selected.map((m) => m.name),
      target: 'first tick >= origin+horizon, delay <= maxTargetDelayMs, target < splitAt',
      maxTargetDelayMs: MAX_TARGET_DELAY, ...modelFrozenMetadata(model),
      reliability: { method: 'empirical-bayes-zero-prior',
        priorVariance: reliability.priorVariance,
        pooledVariance: reliability.pooledVariance,
        meanSamplingVariance: reliability.meanSamplingVariance,
        estimatedCells: reliability.estimatedCells,
        effectiveSampleDefinition: 'non-overlapping 60s labels per cell' },
      mean: Array.from(table), rawMean: Array.from(cells.mean),
      reliabilityFactor: Array.from(reliability.factor),
      effectiveSamples: Array.from(reliability.effectiveSamples),
      standardError: Array.from(reliability.standardError),
      count: Array.from(cells.count),
      variance: Array.from(cells.count, (n, i) => n ? cells.m2[i] / n : null),
    }, null, 2) + '\n';
    await writeFile(resolve(directory, 'frozen-table.json'), frozen);
    const tableHash = createHash('sha256').update(frozen).digest('hex');
    const summary = await output('summary.csv', SUMMARY_HEADERS);
    const orders = await output('orders.csv', ORDER_HEADERS);
    const equity = await output('equity.csv', EQUITY_HEADERS);
    const diagnosticSummary = await output('diagnostic-summary.csv', DIAGNOSTIC_HEADERS);
    const buyAttempts = await output('buy-attempts.csv', ATTEMPT_HEADERS);
    const calibration = await output('forecast-calibration.csv', CALIBRATION_HEADERS);
    const bandCalibration = await output('forecast-band-calibration.csv',
      FORECAST_BAND_HEADERS);
    const lagSummary = await output('ema-lag-summary.csv', LAG_SUMMARY_HEADERS);
    const lagSignals = await output('ema-lag-signals.csv', LAG_SIGNAL_HEADERS);
    const entryQuality = await output('entry-quality.csv', [
      'cell', 'legacyBinaryAllowed', 'legacyReasons', 'trainSamples',
      'nonOverlappingSamples', 'rawAlignedMeanPermille',
      'nonOverlappingAlignedMeanPermille', 'softReliability',
      'shrunkAlignedForecastPermille', 'standardErrorPermille',
    ]);
    for (let cell = 0; cell < ACTIVE_STATE_COUNT; cell++) {
      const reasons = entryQualityReasons(cell, cells, quality);
      if (!Number.isFinite(table[cell])) reasons.push('no-forecast');
      await entryQuality.row([cell, reasons.length === 0, reasons.join('|'),
        cells.count[cell], quality.spaced.count[cell], cells.mean[cell],
        quality.spaced.mean[cell], reliability.factor[cell], table[cell],
        reliability.standardError[cell]]);
    }
    const recordAttempt = attemptRecorder(db);
    for (const market of selected) {
      db.exec('DELETE FROM buy_attempts; BEGIN');
      try {
        await replay(db, market, table, start, end, summary, orders, equity, recordAttempt,
          (simulation, roi) => returns.add(PRICE_EMA_TAU_MS,
            simulation.id, simulation.cost.id, roi));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      await diagnostics(db, market, table, start, end, diagnosticSummary, buyAttempts);
      await writeSignalQuality(db, market, table, cells, quality, start, end, signalQuality);
      await calibrate(db, market, table, start, end, calibration, 'ema-residual',
        lagSummary, lagSignals);
      await calibrate(db, market, table, start, end, calibration, 'raw');
      await calibrateBands(db, market, table, start, end, bandCalibration,
        'ema-residual');
      await calibrateBands(db, market, table, start, end, bandCalibration, 'raw');
      console.log(`${model.id} simulated: ${market.name}`);
    }
    await returns.write(resolve(directory, 'orders_summary.csv'), [PRICE_EMA_TAU_MS]);
    await writeFile(resolve(directory, 'metadata.json'), JSON.stringify({
      version: 4, model: model.id, status: 'complete',
      generatedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
      baseCurrency: BASE_CURRENCY, initialCashPerMarketAndScenario: INITIAL_CASH,
      observations: range, targetDefinition: targetDefinition(),
      emaReady, emaWarmup, configuredTausMs: PRICE_EMA_TAUS_MS,
      dataEnd: DATA_END, observationsSha256,
      fingerprint: 'SHA256 of ordered market names and deduplicated [t,p]; excludes features and EMA',
      featureModel: modelFrozenMetadata(model),
      speedBankExtraction: bankStats,
      researchCache: { path: RESEARCH_CACHE_PATH, metadata: cacheMetadata },
      trainingMarkets: markets.length,
      tradingMarkets: selected.map((m) => m.name),
      splitAt: new Date(splitAt).toISOString(), testStart: new Date(start).toISOString(),
      testEnd: new Date(end).toISOString(), horizonMs: HORIZON,
      minTrainSamples: MIN_TRAIN_SAMPLES, trainSamples, lastTrainTarget,
      tableSha256: tableHash, strategies: STRATEGIES, costs: COSTS,
      latencyMs: LATENCY, maxFillWaitMs: MAX_FILL_WAIT,
      dataSource: 'prepared SQLite cache; disposable working copy adds direct/derived speed-bank states and target EMA',
      comparisonScope: 'paired comparisons are intersection-only: both compared models forecastable and one identical valid target label',
      validation: model.id === 'speed-bank'
        ? 'chronological holdout; direct 7/15/30 speed bank replayed causally from cached raw observations'
        : 'chronological holdout; derived 7/15/30/60 bank replayed causally from cached raw observations',
      softReliability: {
        method: 'empirical-bayes-zero-prior',
        formula: 'forecast=rawMean*priorVar/(priorVar+SE^2)',
        priorVariance: reliability.priorVariance,
        pooledVariance: reliability.pooledVariance,
        effectiveSamples: 'non-overlapping horizon labels',
        testDataUsed: false,
      },
      cellQuality: {
        minSamplesFlag: QUALITY_MIN_SAMPLES, blocks: QUALITY_BLOCKS,
        minBlockSamples: QUALITY_MIN_BLOCK_SAMPLES,
        minNonOverlapping: ENTRY_MIN_NONOVERLAPPING,
        minSpacedMeanRatio: ENTRY_MIN_SPACED_MEAN_RATIO,
        role: 'diagnostic only in v4; does not block entries',
      },
      execution: 'spot-long hypothetical replay with threshold strategies plus forecast-band fixed 60s hold controls; see source constants and CSVs',
    }, null, 2) + '\n');
    return { model, table, trainSamples, lastTrainTarget, tableSha256: tableHash };
  } finally {
    await Promise.allSettled(files.map((file) => file.close()));
  }
}

async function main() {
  for (const strategy of STRATEGIES) {
    if (strategy.exit !== null && !(strategy.entry > strategy.exit)) {
      throw new Error('Entry must exceed exit');
    }
    if (strategy.entryMax !== null && !(strategy.entryMax > strategy.entry)) {
      throw new Error('Entry band upper bound must exceed lower bound');
    }
    if (strategy.fixedHoldMs !== null && strategy.fixedHoldMs <= 0) {
      throw new Error('Fixed hold must be positive');
    }
  }
  for (const cost of COSTS) {
    if (![cost.fee, cost.spread, cost.slip].every(Number.isFinite) ||
      cost.fee < 0 || cost.fee >= 1000 || cost.spread < 0 || cost.slip < 0) {
      throw new Error(`Invalid cost scenario: ${cost.id}`);
    }
  }

  await mkdir(OUTPUT, { recursive: true });
  const runDirectory = await mkdtemp(resolve(OUTPUT, 'run-'));
  const cache = resolve(runDirectory, 'observations.sqlite');
  const returns = new Map<ModelId, OrdersSummary>(
    MODELS.map((model) => [model.id, new OrdersSummary()]));
  let sharedFingerprint: string | null = null;
  const started = Date.now();

  // Never modify the prepared source cache. The disposable copy is cheap
  // compared with decoding storage_archive and keeps the research schema local.
  await copyFile(RESEARCH_CACHE_PATH, cache);
  const db = new DatabaseSync(cache);

  try {
    const schemaVersion = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version,
    );
    if (schemaVersion !== 1) {
      throw new Error(
        `Unsupported research cache schema version: ${schemaVersion}`,
      );
    }

    const cacheMetadata = Object.fromEntries(
      (db.prepare('SELECT key, value FROM metadata').all() as
        { key: string; value: string }[])
        .map(({ key, value }) => [key, value]),
    );

    db.exec(`
      DROP VIEW IF EXISTS observations_readable;
      DROP VIEW IF EXISTS market_cache_stats_readable;

      ALTER TABLE observations RENAME COLUMN market_id TO market;
      ALTER TABLE observations RENAME COLUMN received_at TO t;
      ALTER TABLE observations RENAME COLUMN price TO p;

      ALTER TABLE observations ADD COLUMN bank_cell INTEGER NOT NULL DEFAULT -1;
      ALTER TABLE observations ADD COLUMN bank_sign INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE observations ADD COLUMN derived_bank_cell INTEGER NOT NULL DEFAULT -1;
      ALTER TABLE observations ADD COLUMN derived_bank_sign INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE observations ADD COLUMN e REAL;

      CREATE VIEW speed_bank_observations AS
        SELECT market,t,p,bank_cell AS cell,bank_sign AS sign,e FROM observations;
      CREATE VIEW speed_bank_derived_observations AS
        SELECT market,t,p,derived_bank_cell AS cell,
          derived_bank_sign AS sign,e FROM observations;
      CREATE VIEW target_observations AS
        SELECT market,t,p,0 AS cell,0 AS sign,e FROM observations;
    `);

    // v3 extracted only spot markets from PostgreSQL. The general cache may
    // contain other market types, so preserve the same research population.
    db.exec(`
      DELETE FROM observations
      WHERE market NOT IN (
        SELECT id FROM markets WHERE type = 'spot'
      )
    `);

    if (DATA_END !== null) {
      db.prepare('DELETE FROM observations WHERE t > ?').run(DATA_END);
    }

    const markets = db.prepare(`
      SELECT id, name, stock, money
      FROM markets
      WHERE type = 'spot'
        AND EXISTS (
          SELECT 1 FROM observations WHERE market = markets.id
        )
      ORDER BY name
    `).all() as Market[];

    if (!markets.length) {
      throw new Error('No cached spot markets');
    }

    const rawRange = db.prepare(`
      SELECT min(t) AS first, max(t) AS last, count(*) AS n
      FROM observations
    `).get() as { first: number | null; last: number | null; n: number };
    if (rawRange.first === null || rawRange.last === null) {
      throw new Error('No cached observations');
    }
    const range = { first: rawRange.first, last: rawRange.last, n: rawRange.n };
    const splitAt = REQUESTED_SPLIT ?? Math.ceil(
      range.first + TRAIN_FRACTION * (range.last - range.first));
    const start = REQUESTED_START ?? splitAt;
    const end = REQUESTED_END ?? range.last;
    if (splitAt <= range.first || splitAt >= range.last ||
      start < splitAt || start >= end || end > range.last) {
      throw new Error('Invalid chronological train/test boundaries');
    }

    const requestedNames = process.env.MF_MARKETS === undefined ? MARKET_NAMES :
      process.env.MF_MARKETS.split(',').map((x) => x.trim()).filter(Boolean);
    const eligible = markets.filter((market) => market.money === BASE_CURRENCY &&
      market.stock !== BASE_CURRENCY);
    for (const name of requestedNames) {
      if (!eligible.some((market) => market.name === name)) {
        throw new Error(`No cached spot market quoted in ${BASE_CURRENCY}: ${name}`);
      }
    }
    const selected = eligible.filter((market) => !requestedNames.length ||
      requestedNames.includes(market.name));
    if (!selected.length) throw new Error('No markets selected for simulation');

    console.log(`Research cache: ${RESEARCH_CACHE_PATH}`);
    console.log(`Cached observations: ${range.n}, markets: ${markets.length}`);

    const bankStats: SpeedBankExtractionStats = {
      direct: { ready: 0, warmup: 0, invalid: 0 },
      derived: { ready: 0, warmup: 0, invalid: 0 },
    };
    const derivedDistribution = newDerivedDistribution();
    for (const market of markets) {
      const result = buildSpeedBanksMarket(db, market.id, splitAt,
        derivedDistribution);
      for (const kind of ['direct', 'derived'] as const) {
        bankStats[kind].ready += result[kind].ready;
        bankStats[kind].warmup += result[kind].warmup;
        bankStats[kind].invalid += result[kind].invalid;
      }
      console.log(`Speed banks: ${market.name}, direct ready=${result.direct.ready}, ` +
        `derived ready=${result.derived.ready}`);
    }
    await writeDerivedFeatureDistribution(
      resolve(runDirectory, 'derived-feature-distribution.csv'),
      derivedDistribution,
    );

    for (const tau of PRICE_EMA_TAUS_MS) {
      PRICE_EMA_TAU_MS = tau;
      ACTIVE_SOURCE = 'observations';
      ACTIVE_STATE_COUNT = SPEED_BANK_STATE_COUNT;
      const tauDirectory = resolve(runDirectory, `tau-${tau}ms`);
      await mkdir(tauDirectory);
      console.log(`Starting target EMA tau=${tau}ms`);
      const fingerprint = createHash('sha256');
      let emaReady = 0;
      let emaWarmup = 0;
      for (const market of markets) {
        fingerprint.update(JSON.stringify(market.name) + '\n');
        const result = smoothMarket(db, market.id, fingerprint);
        emaReady += result.ready;
        emaWarmup += result.warmup;
        console.log(`Target EMA: ${market.name}, ready=${result.ready}, warmup=${result.warmup}`);
      }
      const observationsSha256 = fingerprint.digest('hex');
      if (sharedFingerprint !== null) {
        assert.equal(observationsSha256, sharedFingerprint);
      }
      sharedFingerprint = observationsSha256;

      const results = new Map<ModelId, ModelRunResult>();
      for (const model of MODELS) {
        const result = await runModel(db, model, markets, selected, range,
          splitAt, start, end, resolve(tauDirectory, model.id), observationsSha256,
          cacheMetadata, emaReady, emaWarmup, bankStats,
          returns.get(model.id)!, started);
        results.set(model.id, result);
      }

      const comparisonDirectory = resolve(tauDirectory, 'comparison');
      await compareModelPair(
        db,
        selected,
        results.get('speed-bank')!,
        results.get('speed-bank-derived')!,
        start,
        end,
        resolve(comparisonDirectory, 'speed-bank-vs-derived'),
      );

      await writeFile(resolve(tauDirectory, 'metadata.json'), JSON.stringify({
        version: 4,
        status: 'complete',
        researchCache: { path: RESEARCH_CACHE_PATH, metadata: cacheMetadata },
        targetDefinition: targetDefinition(),
        observationsSha256,
        observations: range,
        splitAt: new Date(splitAt).toISOString(),
        testStart: new Date(start).toISOString(),
        testEnd: new Date(end).toISOString(),
        models: Array.from(results.values()).map((r) => ({
          id: r.model.id,
          stateCount: r.model.stateCount,
          trainSamples: r.trainSamples,
          lastTrainTarget: r.lastTrainTarget,
          tableSha256: r.tableSha256,
        })),
        comparisons: ['comparison/speed-bank-vs-derived'],
        comparisonRule: 'pair uses identical valid labels forecastable by both models; forecast-pairs.csv keeps common labels where either abs forecast >= 1 permille',
      }, null, 2) + '\n');
      console.log(`Tau comparison: ${tauDirectory}`);
    }

    for (const model of MODELS) {
      await returns.get(model.id)!.write(
        resolve(runDirectory, `${model.id}-orders_summary.csv`), PRICE_EMA_TAUS_MS);
    }

    await writeFile(resolve(runDirectory, 'comparison.json'), JSON.stringify({
      version: 4,
      status: 'complete',
      researchCache: { path: RESEARCH_CACHE_PATH, metadata: cacheMetadata },
      tausMs: PRICE_EMA_TAUS_MS,
      models: MODELS.map((model) => ({
        id: model.id,
        stateCount: model.stateCount,
      })),
      observationsSha256: sharedFingerprint,
      dataEnd: DATA_END_ISO,
      splitAt: new Date(splitAt).toISOString(),
      testStart: new Date(start).toISOString(),
      testEnd: new Date(end).toISOString(),
      speedBanks: {
        direct: {
          tausMs: SPEED_BANK_TAUS_MS,
          warmupMs: SPEED_BANK_WARMUP_MS,
          ...bankStats.direct,
        },
        derived: {
          tausMs: DERIVED_SPEED_BANK_TAUS_MS,
          warmupMs: DERIVED_SPEED_BANK_WARMUP_MS,
          stateCount: DERIVED_SPEED_BANK_STATE_COUNT,
          ...bankStats.derived,
        },
      },
      derivedFeatureDistribution:
        'derived-feature-distribution.csv; train origins only',
      summary: 'Prepared SQLite cache copied once into the run; direct 3-tau and derived 4-tau/3D banks are replayed causally from the same cached observations; target EMA is computed once per tau.',
    }, null, 2) + '\n');

    console.log(`Comparison run: ${runDirectory}`);
  } finally {
    db.close();
    if (process.env.MF_KEEP_CACHE !== '1') {
      await rm(cache, { force: true });
      await rm(`${cache}-journal`, { force: true });
    }
  }
}

async function selfTest() {
  assert.equal(SPEED_BANK_STATE_COUNT, 2548);
  assert.equal(DERIVED_SPEED_BANK_STATE_COUNT, 2548);
  const bankUp = speedBankCell([2, 1, 0.5]);
  const bankDown = speedBankCell([-2, -1, -0.5]);
  assert.equal(bankUp.cell, bankDown.cell);
  assert.equal(bankUp.sign, 1);
  assert.equal(bankDown.sign, -1);
  const reversal = speedBankCell([-2, 0.25, 0.5]);
  const continuation = speedBankCell([2, 0.25, 0.5]);
  assert.notEqual(reversal.cell, continuation.cell);

  const derivedUp = derivedSpeedBankCell([2, 1, 0.5, 0.25]);
  const derivedDown = derivedSpeedBankCell([-2, -1, -0.5, -0.25]);
  assert.equal(derivedUp.cell, derivedDown.cell);
  assert.equal(derivedUp.sign, 1);
  assert.equal(derivedDown.sign, -1);
  assert.equal(derivedUp.level, derivedDown.level);
  assert.equal(derivedUp.contrast, derivedDown.contrast);
  assert.equal(derivedUp.curvature, derivedDown.curvature);
  const lowCurvature = derivedSpeedBankCell([1, 0.95, 0.8, 0.7]);
  const highCurvature = derivedSpeedBankCell([1, 0.5, 0.8, 0.7]);
  assert.equal(lowCurvature.level, highCurvature.level);
  assert.equal(lowCurvature.contrast, highCurvature.contrast);
  assert.notEqual(lowCurvature.cell, highCurvature.cell);

  const banks = new SpeedBanks();
  let bankState = banks.update(0, 100);
  assert.equal(bankState.direct, null);
  assert.equal(bankState.derived, null);
  bankState = banks.update(SPEED_BANK_WARMUP_MS - 1, 100);
  assert.equal(bankState.direct, null);
  assert.equal(bankState.derived, null);
  bankState = banks.update(SPEED_BANK_WARMUP_MS, 101);
  assert.ok(bankState.direct !== null);
  assert.equal(bankState.derived, null);
  bankState = banks.update(DERIVED_SPEED_BANK_WARMUP_MS - 1, 102);
  assert.ok(bankState.direct !== null);
  assert.equal(bankState.derived, null);
  bankState = banks.update(DERIVED_SPEED_BANK_WARMUP_MS, 103);
  assert.ok(bankState.direct !== null);
  assert.ok(bankState.derived !== null);
  assert.throws(() => banks.update(DERIVED_SPEED_BANK_WARMUP_MS, 103));

  const step = new PriceEma();
  assert.equal(step.update(0, 100), null);
  assert.equal(step.update(PRICE_EMA_WARMUP_MS - 1, 100), null);
  assert.equal(step.update(PRICE_EMA_WARMUP_MS, 100), 100);
  assert.ok(Math.abs(step.update(PRICE_EMA_WARMUP_MS + 3700, 110)! -
    (100 + (1 - Math.exp(-3700 / PRICE_EMA_TAU_MS)) * 10)) < 1e-12);
  assert.throws(() => step.update(PRICE_EMA_WARMUP_MS + 3700, 110));

  const row = (t: number, p: number): Row => ({ t, p, cell: 0, sign: 1 });
  // EMA can rise while the executable reference price falls.
  const origin = { ...row(0, 100), e: 99.7 };
  const target = { ...row(65_000, 99.9), e: 99.89 };
  const lag = lagMetrics(origin, target, 3);
  assert.ok(lag.emaReturn > 0 && lag.rawReturn < 0);
  assert.ok(Math.abs(lag.emaReturn - lag.rawReturn -
    lag.originGap + lag.targetGap) < 1e-10);
  assert.ok(Math.abs(lag.emaReturn - lag.constantTarget - lag.residual) < 1e-10);
  const fixed = { ...row(65_000, 100),
    e: constantPriceEma(100, 99.7, 65_000) };
  assert.ok(Math.abs(lagMetrics(origin, fixed, 3).residual) < 1e-10);
  // Splitting the constant-price interval must produce the same EMA.
  const splitFlat = constantPriceEma(100,
    constantPriceEma(100, 99.7, 1700), 63300);
  assert.ok(Math.abs(splitFlat - fixed.e) < 1e-12);
  const alteredTarget = lagMetrics(origin, { ...target, p: 110, e: 109 }, 3);
  assert.equal(lag.constant60, alteredTarget.constant60);
  assert.equal(lag.reconstructedEmaForecast, alteredTarget.reconstructedEmaForecast);
  const gateCells = newCells();
  const gateQuality = new CellQuality(0, 300000);
  gateCells.count[0] = 300;
  gateCells.mean[0] = -2;
  gateQuality.spaced.count[0] = 100;
  gateQuality.spaced.mean[0] = -1;
  gateQuality.largestMarketCount[0] = 150;
  for (const block of gateQuality.blocks) {
    block.count[0] = 100;
    block.mean[0] = -2;
  }
  assert.deepEqual(entryQualityReasons(0, gateCells, gateQuality), []);
  gateQuality.spaced.mean[0] = -0.99;
  assert.ok(entryQualityReasons(0, gateCells, gateQuality)
    .includes('nonoverlapping-effect-collapse'));
  gateQuality.spaced.mean[0] = 1;
  assert.ok(entryQualityReasons(0, gateCells, gateQuality)
    .includes('nonoverlapping-sign-disagreement'));
  gateQuality.spaced.mean[0] = -1;
  gateQuality.blocks[0].count[0] = 29;
  assert.ok(entryQualityReasons(0, gateCells, gateQuality).includes('sparse-time-blocks'));
  gateQuality.blocks[0].count[0] = 100;
  gateQuality.blocks[0].mean[0] = 1;
  assert.ok(entryQualityReasons(0, gateCells, gateQuality).includes('block-sign-disagreement'));
  gateQuality.spaced.m2[0] = 400;
  const soft = buildSoftReliability(gateCells, gateQuality);
  assert.ok(soft.factor[0] > 0 && soft.factor[0] < 1);
  assert.ok(Math.abs(soft.table[0]) < Math.abs(gateCells.mean[0]));

  const band = FIXED_HOLD_STRATEGIES.find((s) => s.entry === 1.25 &&
    s.entryMax === 1.5)!;
  const held = new Simulation(band, COSTS[0], 250, 2000);
  held.tick(row(0, 100), 1.3);
  assert.equal(held.pending?.side, 'buy');
  held.tick(row(250, 100), 1.3);
  assert.equal(held.buys, 1);
  held.tick(row(60_249, 100), 1.3);
  assert.equal(held.pending, null);
  held.tick(row(60_250, 100), 1.3);
  assert.equal((held.pending as Pending | null)?.reason, 'fixed-hold');
  held.tick(row(60_500, 100), 1.3);
  assert.equal(held.sells, 1);
  assert.equal(held.fixedHoldExits, 1);
  const outsideBand = new Simulation(band, COSTS[0], 250, 2000);
  outsideBand.tick(row(0, 100), 1.6);
  assert.equal(outsideBand.pending, null);

  const original = new Simulation(BASE_STRATEGIES[0], COSTS[0], 250, 2000);
  original.tick(row(0, 100), 4);
  assert.equal(original.pending?.side, 'buy');
  const qcheck = new CellQuality(0, 300000);
  const testCells = newCells();
  qcheck.beginMarket();
  for (const [t, target, value] of [[0, 60000, 2], [1000, 61000, 4],
    [60000, 120000, -1], [120000, 180000, -2], [220000, 280000, 3]]) {
    accumulate(testCells, 0, value);
    qcheck.observe(row(t, 100), row(target, 100), value);
  }
  qcheck.endMarket('A');
  assert.equal(qcheck.spaced.count[0], 4);
  assert.equal(qcheck.blocks[0].count[0], 2);
  assert.equal(qcheck.blocks[0].mean[0], 3);
  assert.equal(qcheck.blocks[1].mean[0], -2);
  assert.equal(qcheck.boundaryCrossings[0], 1);
  assert.equal(qcheck.marketCount[0], 1);
  assert.ok(qcheck.flags(0, testCells).includes('few-samples'));
  qcheck.beginMarket();
  qcheck.observe(row(0, 100), row(60000, 100), 1);
  qcheck.endMarket('B');
  assert.equal(qcheck.spaced.count[0], 5);
  assert.equal(qcheck.marketCount[0], 2);
  assert.throws(() => qcheck.observe(row(290000, 100), row(350000, 100), 1));
  assert.equal(STRATEGIES.length, 54);
  assert.equal(new Set(STRATEGIES.map((x) => x.id)).size, 54);
  for (const strategy of BASE_STRATEGIES) {
    const s = new Simulation(strategy, COSTS[0], 250, 2000);
    s.tick(row(0, 99), 4.7);
    assert.equal(s.buys, 0);
    s.tick(row(200, 99), -1);
    assert.equal(s.buys, 0);
    const buy = s.tick(row(250, 100), 10)!;
    assert.equal(buy.status, 'filled');
    assert.equal(s.entryForecast, 4.7);
    assert.equal(s.entryExecutionPrice, 100);
    assert.equal(s.targetPermille, strategy.targetMode === 'threshold'
      ? strategy.entry : strategy.targetMode === 'initial-forecast' ? 4.7 : null);
    assert.equal(s.stopPrice, 100 * Math.exp(-strategy.entry * 0.5 / 1000));
    // No time limit; positive rolling forecast need not exceed entry threshold.
    s.tick(row(600000, 100), 0.1);
    assert.equal(s.pending, null);
    if (s.targetPrice !== null) {
      s.tick(row(601000, s.targetPrice * (1 - 1e-8)), 20);
      assert.equal(s.pending, null);
      s.tick(row(602000, s.targetPrice), NaN);
      assert.equal((s.pending as Pending | null)?.reason, `target-${strategy.targetMode}`);
      assert.equal(s.sells, 0);
      const sell = s.tick(row(602250, 99), NaN)!;
      assert.equal(sell.execution, 99); // Price gap, not a guaranteed target fill.
      assert.equal(s.targetExits, 1);
    } else {
      s.tick(row(601000, 100), NaN);
      assert.equal(s.pending, null);
      s.tick(row(602000, 100), 0);
      assert.equal((s.pending as Pending | null)?.reason, 'forecast-faded');
      s.tick(row(602250, 101), 1);
      assert.equal(s.forecastExits, 1);
    }
    const stop = new Simulation(strategy, COSTS[0], 250, 2000);
    stop.tick(row(0, 100), 4.7);
    stop.tick(row(250, 100), 4.7);
    stop.tick(row(500, stop.stopPrice!), NaN);
    assert.equal(stop.pending?.reason, 'protective-stop');
    assert.equal(stop.tick(row(3000, 101), 10)?.status, 'expired-no-timely-tick');
    stop.tick(row(3100, 101), 10);
    assert.equal(stop.pending?.reason, 'protective-stop');
    stop.tick(row(3350, 99), 10);
    assert.equal(stop.stopExits, 1);
    assert.equal(stop.units, 0);
    assert.equal(stop.closedPnl, -10);
    if (strategy.exit !== null) {
      const fade = new Simulation(strategy, COSTS[0], 250, 2000);
      fade.tick(row(0, 100), 4.7);
      fade.tick(row(250, 100), 4.7);
      fade.tick(row(500, 100), 0);
      assert.equal(fade.pending?.reason, 'forecast-faded');
    }
  }
  const cost = COSTS.find((c) => c.id === 'moderate')!;
  const s = new Simulation(STRATEGIES[0], cost, 250, 2000);
  s.tick(row(0, 100), 4.7);
  s.tick(row(250, 100), 4.7);
  const factor = Math.exp((cost.spread / 2 + cost.slip) / 1000);
  const fee = cost.fee / 1000;
  assert.ok(Math.abs(s.units - INITIAL_CASH / (100 * factor * (1 + fee))) < 1e-10);
  assert.equal(s.targetPrice, 100 * factor * Math.exp(STRATEGIES[0].entry / 1000));
  s.tick(row(500, 110), 4.7);
  s.tick(row(750, 110), 4.7);
  const expected = INITIAL_CASH * 1.1 / factor ** 2 * (1 - fee) / (1 + fee);
  assert.ok(Math.abs(s.cash - expected) < 1e-9);
  const expired = new Simulation(STRATEGIES[0], COSTS[0], 250, 2000);
  expired.tick(row(0, 100), 4.7);
  assert.equal(expired.tick(row(2251, 100), 4.7)?.status, 'expired-no-timely-tick');
  assert.equal(expired.buys, 0);
  const zero = new Simulation(STRATEGIES[0], COSTS[0], 0, 2000);
  zero.tick(row(0, 100), 4.7);
  assert.equal(zero.buys, 0);
  zero.tick(row(1, 100), 4.7);
  assert.equal(zero.buys, 1);
  zero.tick(row(2, 110), 4.7);
  assert.equal(zero.finish(3)?.status, 'unfilled-at-test-end');
  assert.equal(zero.sells, 0);
  assert.equal(zero.openPnl(110), 100);

  assert.deepEqual(components(100, 101, 103, 104).map((v) => Math.round(v * 1e6)),
    [Math.log(1.03), Math.log(1.01), Math.log(103 / 101),
      Math.log(104 / 101), Math.log(104 / 103)].map((v) => Math.round(v * 1e9)));
  assert.equal(labelAt(row(70000, 100), 60000, 90000).status, 'valid');
  assert.equal(labelAt(row(70001, 100), 60000, 90000).status, 'late-target');
  assert.equal(labelAt(null, 60000, 90000).status, 'no-target');
  assert.equal(labelAt(null, 60000, 59999).status, 'horizon-after-end');
  assert.equal(labelAt(row(61000, 100), 60000, 60000).status, 'no-target');
  const db = new DatabaseSync(':memory:');
  const { tmpdir } = await import('node:os');
  const { readFile } = await import('node:fs/promises');
  const directory = await mkdtemp(resolve(tmpdir(), 'strategy-self-test-'));
  try {
    db.exec(`CREATE TABLE observations (
      market INTEGER, t INTEGER, p REAL,
      bank_cell INTEGER NOT NULL DEFAULT -1, bank_sign INTEGER NOT NULL DEFAULT 0,
      derived_bank_cell INTEGER NOT NULL DEFAULT -1,
      derived_bank_sign INTEGER NOT NULL DEFAULT 0,
      e REAL, PRIMARY KEY(market, t)
    ) WITHOUT ROWID;
    CREATE VIEW speed_bank_observations AS
      SELECT market,t,p,bank_cell AS cell,bank_sign AS sign,e FROM observations;
    CREATE VIEW speed_bank_derived_observations AS
      SELECT market,t,p,derived_bank_cell AS cell,
        derived_bank_sign AS sign,e FROM observations;
    CREATE VIEW target_observations AS
      SELECT market,t,p,0 AS cell,0 AS sign,e FROM observations;`);
    const insert = db.prepare(`INSERT INTO observations
      (market,t,p,bank_cell,bank_sign) VALUES (?, ?, ?, ?, ?)`);
    for (let t = 0; t <= 200_000; t += 1000) {
      insert.run(0, t, 100 * Math.exp(t / 10_000_000), 0, t < 160_000 ? 1 : -1);
    }
    smoothMarket(db, 0);
    const insertConstant = db.prepare(`INSERT INTO observations
      (market,t,p,bank_cell,bank_sign) VALUES (1,?,?,0,1)`);
    for (let t = 0; t <= 200_000; t += 1000) {
      insertConstant.run(t, t === 0 ? 110 : 100);
    }
    smoothMarket(db, 1);
    ACTIVE_SOURCE = 'speed_bank_observations';
    ACTIVE_STATE_COUNT = SPEED_BANK_STATE_COUNT;
    const constantCells = newCells();
    const constantFit = fitMarket(db, 1, 0, 120_000, constantCells);
    assert.ok(constantFit.accepted > 0);
    assert.ok(Math.abs(constantCells.mean[0]) < 1e-10);
    assert.ok(constantCells.m2[0] < 1e-16);
    const before = newCells();
    const qualityBefore = new CellQuality(0, 120000);
    qualityBefore.beginMarket();
    const training = fitMarket(db, 0, 0, 120_000, before,
      (a, b, v) => qualityBefore.observe(a, b, v));
    qualityBefore.endMarket('A');
    const warmupTicks = Math.min(60, Math.ceil(PRICE_EMA_WARMUP_MS / 1000));
    assert.equal(training.accepted, 60 - warmupTicks);
    assert.equal(training.emaUnavailable, warmupTicks);
    assert.equal(training.purged, 60);
    assert.equal(training.lastTarget, warmupTicks < 60 ? 119_000 : -Infinity);
    const endpoints = db.prepare('SELECT t,e,p FROM observations WHERE market=0 ORDER BY t')
      .all() as { t: number; e: number | null; p: number }[];
    const expected = endpoints.slice(warmupTicks, 60).reduce((sum, a) =>
      sum + 1000 * Math.log(endpoints[a.t / 1000 + 60].e! /
        constantPriceEma(a.p, a.e!, HORIZON)), 0) / Math.max(1, 60 - warmupTicks);
    assert.ok(Math.abs(before.mean[0] - expected) < 1e-10);

    db.exec('UPDATE observations SET p=p*10 WHERE t>=120000');
    smoothMarket(db, 0);
    const after = newCells();
    const qualityAfter = new CellQuality(0, 120000);
    qualityAfter.beginMarket();
    assert.deepEqual(fitMarket(db, 0, 0, 120_000, after,
      (a, b, v) => qualityAfter.observe(a, b, v)), training);
    qualityAfter.endMarket('A');
    assert.deepEqual(qualityAfter, qualityBefore);
    assert.deepEqual(after, before);
    db.exec('UPDATE observations SET p=p/10 WHERE t>=120000');
    smoothMarket(db, 0);

    const summary = await Csv.create(resolve(directory, 'summary.csv'), SUMMARY_HEADERS);
    const orders = await Csv.create(resolve(directory, 'orders.csv'), ORDER_HEADERS);
    const equity = await Csv.create(resolve(directory, 'equity.csv'), EQUITY_HEADERS);
    const table = new Float64Array(ACTIVE_STATE_COUNT).fill(NaN);
    table[0] = 3.7;
    const recorder = attemptRecorder(db);
    const compact = new OrdersSummary();
    try {
      await replay(db, { id: 0, name: 'A_USDT', stock: 'A', money: 'USDT' },
        table, 120_000, 200_000, summary, orders, equity, recorder,
        (s, roi) => compact.add(PRICE_EMA_TAU_MS, s.id, s.cost.id, roi));
    } finally { await summary.close(); await orders.close(); await equity.close(); }
    const parse = (text: string) => {
      const lines = text.trim().split('\n').map((line) =>
        line.split(',').map((v) => v.replace(/^"|"$/g, '')));
      const headers = lines.shift()!;
      return lines.map((values) => {
        assert.equal(values.length, headers.length);
        return Object.fromEntries(headers.map((key, i) => [key, values[i]]));
      });
    };
    const diagnosticSummary = await Csv.create(resolve(directory, 'diagnostics.csv'), DIAGNOSTIC_HEADERS);
    const attempts = await Csv.create(resolve(directory, 'attempts.csv'), ATTEMPT_HEADERS);
    // Explicit failed and still-open entries test inclusion independent of completed trades.
    db.prepare('INSERT INTO buy_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('fixture-expired', 1, 'expired', 120000, 100 * Math.exp(0.012), 2, 123000, null);
    db.prepare('INSERT INTO buy_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('fixture-open', 1, 'filled', 190000, 100 * Math.exp(0.019), 2,
        191000, 100 * Math.exp(0.0191));
    try {
      await diagnostics(db, { id: 0, name: 'A_USDT', stock: 'A', money: 'USDT' },
        table, 120000, 200000, diagnosticSummary, attempts);
    } finally { await diagnosticSummary.close(); await attempts.close(); }
    const diagnosticRows = parse(await readFile(resolve(directory, 'diagnostics.csv'), 'utf8'));
    for (const threshold of ENTRY_THRESHOLDS) {
      const r = diagnosticRows.find((r) => r.cohort === 'all-positive-ticks' &&
        Number(r.entryThreshold) === threshold)!;
      assert.equal(Number(r.samples), threshold === 4 ? 0 : 40);
      assert.equal(Number(r.validSignalTargets), threshold === 4 ? 0 : 21);
      assert.equal(Number(r.horizonAfterEnd), threshold === 4 ? 0 : 19);
      if (threshold < 4) assert.ok(Math.abs(Number(r.meanSignalToTargetPermille) - 6) < 1e-9);
    }
    const attemptRows = parse(await readFile(resolve(directory, 'attempts.csv'), 'utf8'));
    const expired = attemptRows.find((r) => r.strategy === 'fixture-expired')!;
    assert.equal(expired.signalTargetStatus, 'valid');
    assert.equal(expired.fillAt, '');
    assert.equal(expired.fillToFillTargetPermille, '');
    const openEntry = attemptRows.find((r) => r.strategy === 'fixture-open')!;
    assert.equal(openEntry.signalTargetStatus, 'horizon-after-end');
    assert.equal(openEntry.commonSample, 'false');
    if (LATENCY === 250 && MAX_FILL_WAIT === 2000) {
      assert.ok(attemptRows.some((r) => r.commonSample === 'true'));
    }
    for (const r of attemptRows.filter((r) => r.commonSample === 'true')) {
      assert.ok(Math.abs(Number(r.signalToTargetPermille) - Number(r.signalToFillPermille) -
        Number(r.fillToSignalTargetPermille)) < 1e-9);
      assert.ok(Math.abs(Number(r.fillToFillTargetPermille) - Number(r.fillToSignalTargetPermille) -
        Number(r.endpointShiftPermille)) < 1e-9);
    }
    const calibrationFile = await Csv.create(resolve(directory, 'calibration.csv'), CALIBRATION_HEADERS);
    const lagFile = await Csv.create(resolve(directory, 'lag.csv'), LAG_SUMMARY_HEADERS);
    const lagDetail = await Csv.create(resolve(directory, 'lag-detail.csv'), LAG_SIGNAL_HEADERS);
    try {
      await calibrate(db, { id: 0, name: 'A_USDT', stock: 'A', money: 'USDT' },
        table, 120000, 200000, calibrationFile, 'raw');
      await calibrate(db, { id: 0, name: 'A_USDT', stock: 'A', money: 'USDT' },
        table, 120000, 200000, calibrationFile, 'ema-residual', lagFile, lagDetail);
    } finally {
      await calibrationFile.close(); await lagFile.close(); await lagDetail.close();
    }
    const calibrationRows = parse(await readFile(resolve(directory, 'calibration.csv'), 'utf8'));
    const up = calibrationRows.find((r) => r.priceBasis === 'raw' && r.direction === 'up' && r.absForecastThreshold === '2')!;
    assert.equal(Number(up.validTargets), 21);
    assert.equal(Number(up.correctDirection), 21);
    assert.ok(Math.abs(Number(up.meanActualPermille) - 6) < 1e-9);
    const down = calibrationRows.find((r) => r.priceBasis === 'raw' && r.direction === 'down' && r.absForecastThreshold === '2')!;
    assert.equal(Number(down.samples), 41);
    assert.equal(Number(down.validTargets), 0);
    assert.equal(Number(down.horizonAfterEnd), 41);
    const emaUp = calibrationRows.find((r) => r.priceBasis === 'ema-residual' &&
      r.direction === 'up' && r.absForecastThreshold === '2')!;
    assert.equal(Number(emaUp.validTargets), Number(up.validTargets));
    assert.ok(Number(emaUp.meanActualPermille) > 4 &&
      Number(emaUp.meanActualPermille) < 6);
    const lagRows = parse(await readFile(resolve(directory, 'lag.csv'), 'utf8'));
    const lagUp = lagRows.find((r) => r.direction === 'up' && r.absForecastThreshold === '2')!;
    assert.equal(Number(lagUp.validTargets), Number(emaUp.validTargets));
    assert.ok(Math.abs(Number(lagUp.mean_residual_permille) -
      Number(emaUp.meanActualPermille)) < 1e-10);
    const lagDetails = parse(await readFile(resolve(directory, 'lag-detail.csv'), 'utf8'));
    assert.equal(lagDetails.length, 21);
    for (const r of lagDetails) {
      assert.ok(Math.abs(Number(r.emaReturnPermille) - Number(r.rawReturnPermille) -
        Number(r.originGapPermille) + Number(r.targetGapPermille)) < 1e-10);
      assert.ok(Number(r.priceOrigin) !== Number(r.emaOrigin));
    }
    const errorMean = lagDetails.reduce((sum, r) => sum +
      Math.abs(Number(r.forecastPermille) - Number(r.residualPermille)), 0) / lagDetails.length;
    assert.ok(Math.abs(errorMean - Number(lagUp.residualForecastMAEPermille)) < 1e-10);
    const summaries = parse(await readFile(resolve(directory, 'summary.csv'), 'utf8'));
    assert.equal(summaries.length, COSTS.length * (STRATEGIES.length + 1));
    for (const r of summaries) {
      assert.equal(Number(r.testTicks), 81);
      assert.equal(Number(r.validForecastTicks), 81);
      assert.ok(Math.abs(Number(r.finalLiquidationEquity) - INITIAL_CASH -
        Number(r.closedPnlQuote) - Number(r.openLiquidationPnlQuote)) < 1e-8);
      if (r.strategy.startsWith('entry-4-')) assert.equal(Number(r.buys), 0);
      assert.equal(Number(r.sells), Number(r.targetExits) + Number(r.stopExits) +
        Number(r.forecastExits) + Number(r.fixedHoldExits));
    }
    await compact.write(resolve(directory, 'orders_summary.csv'), [PRICE_EMA_TAU_MS]);
    const compactRows = parse(await readFile(resolve(directory, 'orders_summary.csv'), 'utf8'));
    assert.equal(compactRows.length, STRATEGIES.length + 1);
    for (const r of summaries) {
      const c = compactRows.find((item) => item.strategy === r.strategy)!;
      assert.equal(Number(c[`tau_${PRICE_EMA_TAU_MS}ms_${r.costScenario}_netReturnPct`]),
        Number(r.netReturnPct));
    }
    const fixture = new OrdersSummary();
    const id = STRATEGIES[0].id;
    fixture.add(10_000, id, 'moderate', 4);
    fixture.add(10_000, id, 'moderate', 0);
    fixture.add(10_000, id, 'moderate', null);
    fixture.add(7_000, id, 'moderate', -1);
    await fixture.write(resolve(directory, 'comparison.csv'), [10_000, 7_000]);
    const pivot = parse(await readFile(resolve(directory, 'comparison.csv'), 'utf8'))[0];
    assert.equal(Number(pivot.tau_10000ms_moderate_netReturnPct), 2);
    assert.equal(Number(pivot.tau_7000ms_moderate_netReturnPct), -1);
    assert.equal(pivot['tau_10000ms_fee-only_netReturnPct'], '');
    const events = parse(await readFile(resolve(directory, 'orders.csv'), 'utf8'));
    for (const e of events.filter((e) => e.status === 'filled')) {
      assert.ok(Number(e.resolvedAt) > Number(e.signalAt));
      assert.ok(Number(e.resolvedAt) >= Number(e.eligibleAt));
      assert.ok(Number(e.resolvedAt) <= Number(e.eligibleAt) + MAX_FILL_WAIT);
    }
    const control = summaries.find((r) => r.strategy === 'entry-3-forecast-zero' &&
      r.costScenario === 'zero-cost-control')!;
    if (LATENCY === 250 && MAX_FILL_WAIT === 2000) {
      assert.equal(Number(control.buys), 1);
      assert.equal(Number(control.sells), 1);
      assert.ok(Number(control.netReturnPct) > 0);
    }
    parse(await readFile(resolve(directory, 'equity.csv'), 'utf8'));
    console.log('Self-test passed: chronological training, future-data isolation,');
    console.log('delayed fills, costs, expiry, inventory, terminal valuation and CSV replay.');
    console.log('combined harness: residual labels, soft reliability, direct/derived speed-bank invariants.');
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function run() {
  if (!PRICE_EMA_TAUS_MS.length || new Set(PRICE_EMA_TAUS_MS).size !== PRICE_EMA_TAUS_MS.length ||
    PRICE_EMA_TAUS_MS.some((t) => !Number.isSafeInteger(t) || t < 1 || t > 60_000)) {
    throw new Error('PRICE_EMA_TAUS_MS: use unique integer values in [1, 60000]');
  }
  if (!process.argv.includes('--self-test')) return main();
  for (const tau of PRICE_EMA_TAUS_MS) {
    PRICE_EMA_TAU_MS = tau;
    console.log(`Self-test tau=${tau}ms`);
    await selfTest();
  }
}

void run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
