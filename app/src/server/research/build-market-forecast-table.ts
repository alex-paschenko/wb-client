// Run from app: node --import tsx src/server/research/build-market-forecast-table.ts
// The prepared research cache is opened read-only. The first 70% of calendar
// time fits base tables; the remaining 30% fits the combiner. No backtest.
import { DatabaseSync } from 'node:sqlite';
import { writeFile, rename, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, basename } from 'node:path';

// Update this filename when a newer prepared SQLite cache is available.
const RESEARCH_CACHE_PATH = resolve(
  'research-output/market-research-cache/' +
  'market-research-cache_endedAt-2026-10-02_01-40-49Z.sqlite',
);

const OUTPUT = process.env.MF_TABLE_OUTPUT
  ? resolve(process.env.MF_TABLE_OUTPUT)
  : fileURLToPath(new URL('../constants/market-forecast-table.ts', import.meta.url));
const TAUS = [7_000, 15_000, 30_000, 60_000] as const;
const PRICE_TAU = 7_000;
const HORIZON = 60_000;
const MAX_TARGET_DELAY = 10_000;
const DIRECT_WARMUP = 150_000;
const DERIVED_WARMUP = 300_000;
const PRICE_WARMUP = 50_000;
const MIN_SAMPLES = 30;
const META_MIN_SPACED = 10;
const ALIGNED = [-3, -1, -0.3, 0, 0.1, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5];
const SLOW = [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8];
const CURVATURE = [-8, -4, -2, -1, -0.5, -0.2, 0, 0.2, 0.5, 1, 2, 4, 8];
const FORECAST = [-4, -3, -2.5, -2, -1.5, -1, -0.5, 0,
  0.5, 1, 1.5, 2, 2.5, 3, 4];
const BASE_CELLS = (ALIGNED.length + 1) ** 2 * (SLOW.length + 1);
const META_CELLS = (FORECAST.length + 1) ** 2;

type Tick = { t: number; p: number };
type Market = { id: number; name: string };
type Cell = { index: number; sign: number } | null;
type State = { direct: Cell; derived: Cell; priceEma: number | null };
type Origin = Tick & State & { directForecast?: number; derivedForecast?: number };

function bin(x: number, boundaries: readonly number[]): number {
  const i = boundaries.findIndex((boundary) => x < boundary);
  return i < 0 ? boundaries.length : i;
}

function metaIndex(direct: number, derived: number): number {
  return bin(direct, FORECAST) * (FORECAST.length + 1) +
    bin(derived, FORECAST);
}

class OnlineEma {
  value = NaN;
  first = NaN;
  previous = NaN;

  constructor(private readonly tau: number) {}

  update(t: number, input: number): number {
    if (!Number.isFinite(this.previous)) {
      this.first = t;
      this.value = input;
    } else {
      if (t <= this.previous) throw new Error('Ticks must have strictly increasing timestamps');
      this.value += -Math.expm1(-(t - this.previous) / this.tau) *
        (input - this.value);
    }
    this.previous = t;
    return this.value;
  }
}

class Features {
  private readonly bank = TAUS.map((tau) => new OnlineEma(tau));
  private readonly price = new OnlineEma(PRICE_TAU);

  update({ t, p }: Tick): State {
    if (!Number.isFinite(p) || p <= 0) throw new Error('Invalid cached price');
    const x = 1000 * Math.log(p);
    const v = this.bank.map((ema, i) => (x - ema.update(t, x)) /
      (TAUS[i] / 60_000));
    const e = this.price.update(t, p);
    const directSign = Math.sign(v[2]);
    const derivedSign = Math.sign(v[3]);
    const direct: Cell = t - this.bank[0].first < DIRECT_WARMUP || !directSign
      ? null : {
        index: (bin(v[0] * directSign, ALIGNED) * (ALIGNED.length + 1) +
          bin(v[1] * directSign, ALIGNED)) * (SLOW.length + 1) +
          bin(Math.abs(v[2]), SLOW),
        sign: directSign,
      };
    const contrast = (v[0] - v[2]) * derivedSign;
    const curvature = ((v[0] - v[1]) / ((15 - 7) / 60) -
      (v[2] - v[3]) / ((60 - 30) / 60)) * derivedSign;
    const derived: Cell = t - this.bank[0].first < DERIVED_WARMUP ||
      !derivedSign || ![contrast, curvature].every(Number.isFinite)
      ? null : {
        index: (bin(contrast, ALIGNED) * (CURVATURE.length + 1) +
          bin(curvature, CURVATURE)) * (SLOW.length + 1) +
          bin(Math.abs(v[3]), SLOW),
        sign: derivedSign,
      };
    return {
      direct,
      derived,
      priceEma: t - this.price.first < PRICE_WARMUP ? null : e,
    };
  }
}

class Moments {
  readonly count: Float64Array;
  readonly mean: Float64Array;
  readonly m2: Float64Array;

  constructor(size: number) {
    this.count = new Float64Array(size);
    this.mean = new Float64Array(size);
    this.m2 = new Float64Array(size);
  }

  add(cell: number, value: number): void {
    const n = ++this.count[cell];
    const delta = value - this.mean[cell];
    this.mean[cell] += delta / n;
    this.m2[cell] += delta * (value - this.mean[cell]);
  }
}

class BaseTable {
  readonly all = new Moments(BASE_CELLS);
  readonly spaced = new Moments(BASE_CELLS);
  private readonly lastTarget = new Float64Array(BASE_CELLS);
  samples = 0;

  beginMarket(): void { this.lastTarget.fill(-Infinity); }

  observe(cell: Cell, origin: Origin, target: Tick, residual: number): void {
    if (!cell) return;
    const aligned = residual * cell.sign;
    this.all.add(cell.index, aligned);
    this.samples++;
    if (origin.t >= this.lastTarget[cell.index]) {
      this.spaced.add(cell.index, aligned);
      this.lastTarget[cell.index] = target.t;
    }
  }

  freeze(): Float64Array {
    let pooledM2 = 0;
    let pooledDf = 0;
    let secondMoment = 0;
    let samplingVariance = 0;
    let estimatedCells = 0;
    for (let i = 0; i < BASE_CELLS; i++) {
      const n = this.spaced.count[i];
      if (n > 1) {
        pooledM2 += this.spaced.m2[i];
        pooledDf += n - 1;
      }
    }
    const pooledVariance = pooledDf ? pooledM2 / pooledDf : 1;
    for (let i = 0; i < BASE_CELLS; i++) {
      const n = this.spaced.count[i];
      if (this.all.count[i] < MIN_SAMPLES || n < 2) continue;
      const local = this.spaced.m2[i] / (n - 1);
      secondMoment += this.all.mean[i] ** 2;
      samplingVariance += (Number.isFinite(local) ? local : pooledVariance) / n;
      estimatedCells++;
    }
    const prior = Math.max(1e-6,
      (estimatedCells ? secondMoment / estimatedCells : 0) -
      (estimatedCells ? samplingVariance / estimatedCells : 0));
    const result = new Float64Array(BASE_CELLS).fill(NaN);
    for (let i = 0; i < BASE_CELLS; i++) {
      const n = this.spaced.count[i];
      if (this.all.count[i] < MIN_SAMPLES || !n) continue;
      const local = n > 1 ? this.spaced.m2[i] / (n - 1) : pooledVariance;
      const variance = Number.isFinite(local) ? local : pooledVariance;
      result[i] = this.all.mean[i] * prior /
        (prior + Math.max(0, variance) / n);
    }
    return result;
  }
}

class Combiner {
  readonly all = new Moments(META_CELLS);
  readonly spaced = new Moments(META_CELLS);
  private readonly lastTarget = new Float64Array(META_CELLS);
  samples = 0;

  beginMarket(): void { this.lastTarget.fill(-Infinity); }

  observe(origin: Origin, target: Tick, residual: number): void {
    const direct = origin.directForecast!;
    const derived = origin.derivedForecast!;
    const cell = metaIndex(direct, derived);
    const correction = residual - (direct + derived) / 2;
    this.all.add(cell, correction);
    this.samples++;
    if (origin.t >= this.lastTarget[cell]) {
      this.spaced.add(cell, correction);
      this.lastTarget[cell] = target.t;
    }
  }

  freeze(): Float64Array {
    let pooledM2 = 0;
    let pooledDf = 0;
    let secondMoment = 0;
    let samplingVariance = 0;
    let estimatedCells = 0;
    for (let i = 0; i < META_CELLS; i++) {
      const n = this.spaced.count[i];
      if (n > 1) {
        pooledM2 += this.spaced.m2[i];
        pooledDf += n - 1;
      }
      if (this.all.count[i] < MIN_SAMPLES || n < META_MIN_SPACED) continue;
      secondMoment += this.all.mean[i] ** 2;
      samplingVariance += this.spaced.m2[i] / (n - 1) / n;
      estimatedCells++;
    }
    const pooledVariance = pooledDf ? pooledM2 / pooledDf : 1;
    const prior = Math.max(1e-6,
      (secondMoment - samplingVariance) / Math.max(1, estimatedCells));
    const result = new Float64Array(META_CELLS);
    for (let i = 0; i < META_CELLS; i++) {
      const n = this.spaced.count[i];
      if (this.all.count[i] < MIN_SAMPLES || n < META_MIN_SPACED) continue;
      const local = this.spaced.m2[i] / (n - 1);
      const variance = Number.isFinite(local) ? local : pooledVariance;
      result[i] = this.all.mean[i] * prior /
        (prior + Math.max(0, variance) / n);
    }
    return result;
  }
}

function forecast(state: Cell, table: Float64Array): number {
  return state ? table[state.index] * state.sign : NaN;
}

function residual(origin: Origin, target: Tick, targetEma: number): number {
  const dt = target.t - origin.t;
  const flatEma = origin.p + (origin.priceEma! - origin.p) *
    Math.exp(-dt / PRICE_TAU);
  return 1000 * Math.log(targetEma / flatEma);
}

function* ticks(db: DatabaseSync, marketId: number, start: number,
  end: number): Generator<Tick> {
  const query = db.prepare(`SELECT received_at AS t, price AS p FROM observations
    WHERE market_id=? AND received_at>=? AND received_at<? ORDER BY received_at`);
  for (const row of query.iterate(marketId, start, end)) yield row as Tick;
}

function trainMarket(db: DatabaseSync, market: Market, features: Features,
  direct: BaseTable, derived: BaseTable, end: number): void {
  direct.beginMarket();
  derived.beginMarket();
  const pending: Origin[] = [];
  let head = 0;
  for (const tick of ticks(db, market.id, -Number.MAX_SAFE_INTEGER, end)) {
    const state = features.update(tick);
    while (head < pending.length && pending[head].t + HORIZON <= tick.t) {
      const origin = pending[head++];
      if (tick.t - origin.t - HORIZON > MAX_TARGET_DELAY ||
        origin.priceEma === null || state.priceEma === null) continue;
      const label = residual(origin, tick, state.priceEma);
      direct.observe(origin.direct, origin, tick, label);
      derived.observe(origin.derived, origin, tick, label);
    }
    if (head > 4096 && head * 2 > pending.length) {
      pending.splice(0, head);
      head = 0;
    }
    if (tick.t + HORIZON < end && (state.direct || state.derived)) {
      pending.push({ ...tick, ...state });
    }
  }
}

function calibrateMarket(db: DatabaseSync, market: Market, features: Features,
  direct: Float64Array, derived: Float64Array, combiner: Combiner,
  start: number, end: number): void {
  combiner.beginMarket();
  const pending: Origin[] = [];
  let head = 0;
  for (const tick of ticks(db, market.id, start, end)) {
    const state = features.update(tick);
    while (head < pending.length && pending[head].t + HORIZON <= tick.t) {
      const origin = pending[head++];
      if (tick.t - origin.t - HORIZON > MAX_TARGET_DELAY ||
        origin.priceEma === null || state.priceEma === null) continue;
      combiner.observe(origin, tick, residual(origin, tick, state.priceEma));
    }
    if (head > 4096 && head * 2 > pending.length) {
      pending.splice(0, head);
      head = 0;
    }
    const d = forecast(state.direct, direct);
    const r = forecast(state.derived, derived);
    if (Number.isFinite(d) && Number.isFinite(r) && d !== 0 && r !== 0 &&
      tick.t + HORIZON < end) {
      pending.push({ ...tick, ...state, directForecast: d, derivedForecast: r });
    }
  }
}

function formatArray(values: ArrayLike<number>): string {
  const lines: string[] = [];
  for (let i = 0; i < values.length; i += 8) {
    const row = Array.from({ length: Math.min(8, values.length - i) },
      (_, j) => Number.isFinite(values[i + j])
        ? String(values[i + j]) : 'NaN');
    lines.push(`  ${row.join(', ')},`);
  }
  return lines.join('\n');
}

export function renderTables(
  direct: Float64Array, derived: Float64Array, correction: Float64Array,
  source: string,
): string {
  if (direct.length !== BASE_CELLS || derived.length !== BASE_CELLS ||
    correction.length !== META_CELLS ||
    correction.some((value) => !Number.isFinite(value))) {
    throw new Error('Unexpected size or invalid correction in forecast tables');
  }
  const constant = (name: string, values: ArrayLike<number>) =>
    `export const ${name} = new Float64Array([\n${formatArray(values)}\n]);\n`;
  return `// Generated by research/build-market-forecast-table.ts.\n` +
    `// Do not edit by hand. ${source}\n` +
    `// Forecasts are 60 s constant-price EMA residuals in promille.\n\n` +
    `export const MARKET_FORECAST_ALIGNED_BINS = ${JSON.stringify(ALIGNED)} as const;\n` +
    `export const MARKET_FORECAST_SLOW_BINS = ${JSON.stringify(SLOW)} as const;\n` +
    `export const MARKET_FORECAST_CURVATURE_BINS = ${JSON.stringify(CURVATURE)} as const;\n` +
    `export const MARKET_FORECAST_PAIR_BINS = ${JSON.stringify(FORECAST)} as const;\n\n` +
    constant('MARKET_FORECAST_3_EMA', direct) + '\n' +
    constant('MARKET_FORECAST_4_EMA', derived) + '\n' +
    constant('MARKET_FORECAST_COMBINED_CORRECTION', correction);
}

async function main(): Promise<void> {
  if (process.argv[2] === '--from-frozen' && process.argv.length === 4) {
    // Bootstrap the project without a local SQLite by importing the already
    // trained v6 artifacts. A normal run with SQLite refits both time ranges.
    const directory = resolve(process.argv[3]);
    const base = async (name: string) => JSON.parse(await readFile(
      resolve(directory, name, 'frozen-table.json'), 'utf8')) as {
        mean: (number | null)[]; baseFitEnd: string; trainSamples: number;
      };
    const direct = await base('speed-bank');
    const derived = await base('speed-bank-derived');
    const meta = JSON.parse(await readFile(resolve(directory, 'combined',
      'frozen-combiner.json'), 'utf8')) as {
        correction: number[]; metaFitEnd: string; coverage: { valid: number };
      };
    const content = renderTables(
      Float64Array.from(direct.mean, (n) => n ?? NaN),
      Float64Array.from(derived.mean, (n) => n ?? NaN),
      Float64Array.from(meta.correction),
      `Bootstrap from frozen v6: base to ${direct.baseFitEnd} ` +
        `(${direct.trainSamples}/${derived.trainSamples} labels); ` +
        `meta to ${meta.metaFitEnd} (${meta.coverage.valid} labels).`,
    );
    const temporary = `${OUTPUT}.${process.pid}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, OUTPUT);
    console.log(`Imported existing frozen tables into ${OUTPUT}`);
    return;
  }
  const db = new DatabaseSync(RESEARCH_CACHE_PATH, { readOnly: true });
  try {
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version !== 1) throw new Error('Expected prepared cache schema v1');
    const markets = db.prepare(`SELECT id,name FROM markets WHERE type='spot'
      AND EXISTS(SELECT 1 FROM observations WHERE market_id=markets.id)
      ORDER BY name`).all() as Market[];
    if (!markets.length) throw new Error('No spot markets in cache');
    const span = db.prepare(`SELECT min(o.received_at) AS first,
      max(o.received_at) AS last FROM observations o JOIN markets m
      ON m.id=o.market_id WHERE m.type='spot'`).get() as
      { first: number | null; last: number | null };
    if (span.first === null || span.last === null) throw new Error('Empty cache');
    const baseEnd = Math.ceil(span.first + 0.7 * (span.last - span.first));
    const metaEnd = span.last + 1;
    if (baseEnd <= span.first + DERIVED_WARMUP + HORIZON ||
      metaEnd <= baseEnd + HORIZON) throw new Error('Cache too short for two stages');

    const base3 = new BaseTable();
    const base4 = new BaseTable();
    const features = new Map<number, Features>();
    for (const market of markets) {
      const bank = new Features();
      trainMarket(db, market, bank, base3, base4, baseEnd);
      features.set(market.id, bank);
      console.log(`Base fit: ${market.name}`);
    }
    const direct = base3.freeze();
    const derived = base4.freeze();
    if (!direct.some(Number.isFinite) || !derived.some(Number.isFinite)) {
      throw new Error('No usable base table cells');
    }
    const combiner = new Combiner();
    for (const market of markets) {
      calibrateMarket(db, market, features.get(market.id)!, direct, derived,
        combiner, baseEnd, metaEnd);
      console.log(`Meta fit: ${market.name}`);
    }
    if (!combiner.samples) throw new Error('No valid meta fit labels');
    const correction = combiner.freeze();
    const source = `Cache ${basename(RESEARCH_CACHE_PATH)}; ` +
      `${markets.length} spot markets; ` +
      `base to ${new Date(baseEnd).toISOString()} (${base3.samples}/${base4.samples} labels), ` +
      `meta to ${new Date(span.last).toISOString()} (${combiner.samples} labels).`;
    const temporary = `${OUTPUT}.${process.pid}.tmp`;
    await writeFile(temporary, renderTables(direct, derived, correction, source));
    await rename(temporary, OUTPUT);
    console.log(`Updated ${OUTPUT}`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
