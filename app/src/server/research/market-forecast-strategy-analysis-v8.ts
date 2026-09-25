// app/src/server/research/market-forecast-strategy-analysis.ts
// v8: EMA lag diagnostics and constant-price control; raw-price execution.
// Research only: local simulation, no exchange order submission.
// Run from app with node --import tsx; append --self-test for offline tests.
// MF_PRICE_EMA_TAU_MS=7000 selects a 7-second EMA (default: 10000).
// MF_DATA_END caps raw observations by receivedAt for repeatable comparisons.
// Pin MF_SPLIT_AT as well; compare metadata.observationsSha256 between runs.
// Lag diagnostics are retrospective and never feed execution decisions.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MarketCandle, MarketPhaseValue } from '../../shared/types/data-types.js';
import type { LazyArray } from '../../shared/utilities/lazy-array.js';
import { getMarketPhaseTau } from '../utilities/time.js';

const BASE_CURRENCY = 'USDT';
const PRICE_EMA_TAU_MS = integer('MF_PRICE_EMA_TAU_MS', 10_000, 1, 60_000);
// Keep the 7s and 10s comparisons on the same warmup window.
const PRICE_EMA_WARMUP_MS = Math.max(50_000, 5 * PRICE_EMA_TAU_MS);
const TARGET_DEFINITION = {
  kind: 'price-ema-to-price-ema', tauMs: PRICE_EMA_TAU_MS,
  warmupMs: PRICE_EMA_WARMUP_MS,
  formula: '1000 * ln(EMA(target) / EMA(origin))',
  update: 'alpha=-expm1(-dt/tau); E += alpha*(price-E)',
  initialization: 'first valid price per market; exclude max(50s,5*tau) from labels',
  gaps: 'continuous time update across gaps; no synthetic ticks or resets',
  phaseInput: 'unchanged stored marketPhase; EMA is for labels only',
};
// Empty means all archived spot markets quoted in BASE_CURRENCY.
// Example: ['BTC_USDT', 'ETH_USDT']. This affects trading, not training.
const MARKET_NAMES: string[] = [];
const INITIAL_CASH = 1000;
const TRAIN_FRACTION = 0.7;
const HORIZON = 60_000;
const RESPONSE_TIME = 30_000;
const PHASE_NAME = 'phase-30s';
const TAU = getMarketPhaseTau(RESPONSE_TIME) / 60_000;
const MAX_TARGET_DELAY = 10_000;
const MIN_TRAIN_SAMPLES = integer('MF_MIN_TRAIN_SAMPLES', 30, 1, 1_000_000);
const LATENCY = integer('MF_LATENCY_MS', 250, 0, 60_000);
const MAX_FILL_WAIT = integer('MF_MAX_FILL_WAIT_MS', 2000, 0, 300_000);
const ENTRY_THRESHOLDS = [2, 2.5, 3, 3.5, 4];
const STOP_FRACTION = 0.5;
// Diagnostic thresholds only: they do not suppress strategy entries.
const QUALITY_MIN_SAMPLES = 100;
const QUALITY_BLOCKS = 3;
const QUALITY_MIN_BLOCK_SAMPLES = 30;
const EQUITY_INTERVAL = 300_000;
const MAX_BLOB = integer('MF_MAX_SNAPSHOT_MB', 64, 1, 1024) * 1024 ** 2;
const DATA_END = dateEnv('MF_DATA_END');
const REQUESTED_SPLIT = dateEnv('MF_SPLIT_AT');
const REQUESTED_START = dateEnv('MF_TEST_START');
const REQUESTED_END = dateEnv('MF_TEST_END');
const OUTPUT = resolve(`research-output/market-forecast-strategy-v8/tau-${PRICE_EMA_TAU_MS}ms`);
const PAGE = 2048;
const SPEED_BINS = [0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8];
const ACCEL_BINS = [-4, -2, -1, -0.5, -0.2, 0, 0.2, 0.5, 1, 2, 4];
const SURPRISE_BINS = [
  -5, -3, -2, -1.5, -1, -0.75, -0.5, -0.25, 0,
  0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5,
];
const STATE_COUNT = (SPEED_BINS.length + 1) *
  (ACCEL_BINS.length + 1) * (SURPRISE_BINS.length + 1);

// All costs below are assumed scenarios, NOT current exchange fee quotes.
// Units: permille, so fee=1 means 0.1% per execution, spread=1 means 0.1% full spread.
const COSTS = [
  { id: 'zero-cost-control', fee: 0, spread: 0, slip: 0 },
  { id: 'fee-only', fee: 1, spread: 0, slip: 0 },
  { id: 'moderate', fee: 1, spread: 0.5, slip: 0.25 },
  { id: 'wide', fee: 1, spread: 2, slip: 0.5 },
];
// Fixed research variants, not selected by test-period profitability.
type Strategy = { id: string; entry: number; exit: number | null;
  exitMode: string; targetMode: 'none' | 'threshold' | 'initial-forecast';
  stopPermille: number };
const STRATEGIES: Strategy[] = ENTRY_THRESHOLDS.flatMap((entry) => [
  { suffix: 'target-threshold', targetMode: 'threshold' as const, exit: null },
  { suffix: 'target-forecast', targetMode: 'initial-forecast' as const, exit: null },
  { suffix: 'forecast-zero', targetMode: 'none' as const, exit: 0 },
  { suffix: 'target-threshold-or-zero', targetMode: 'threshold' as const, exit: 0 },
  { suffix: 'target-forecast-or-zero', targetMode: 'initial-forecast' as const, exit: 0 },
].map(({ suffix, targetMode, exit }) => ({
  id: `entry-${entry}-${suffix}`, entry, exit, exitMode: suffix,
  targetMode, stopPermille: entry * STOP_FRACTION,
})));

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

function dateEnv(name: string): number | null {
  const text = process.env[name];
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

function phaseCell(phase: MarketPhaseValue): number {
  const { speed: v, acceleration: a, surprise: s, residualVariance: vr } = phase;
  if (![v, a, s, vr].every(Number.isFinite) || v === 0 || vr <= 0) return -1;
  const features = [Math.abs(v) * TAU / Math.sqrt(vr), a * TAU / v,
    s * Math.sign(v)];
  if (!features.every(Number.isFinite)) return -1;
  return (bin(features[0], SPEED_BINS) * (ACCEL_BINS.length + 1) +
    bin(features[1], ACCEL_BINS)) * (SURPRISE_BINS.length + 1) +
    bin(features[2], SURPRISE_BINS);
}

// One state and one bounded page per market. Never smooth archive duplicates.
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
  const query = db.prepare(`SELECT t,p,cell,sign FROM observations
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
        fingerprint?.update(JSON.stringify([row.t, row.p, row.cell, row.sign]) + '\n');
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
      SELECT t, p, cell, sign, e FROM observations
      WHERE market = ? AND t > ? ORDER BY t LIMIT ${PAGE}
    `);
    this.market = market;
    const seed = db.prepare(`
      SELECT t, p, cell, sign, e FROM observations
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
  return { count: new Float64Array(STATE_COUNT),
    mean: new Float64Array(STATE_COUNT), m2: new Float64Array(STATE_COUNT) };
}

function fitMarket(db: DatabaseSync, market: number, first: number,
  splitAt: number, cells: ReturnType<typeof newCells>,
  observe?: (origin: Row, target: Row, alignedReturn: number) => void) {
  const target = new Reader(db, market, first);
  const query = db.prepare(`
    SELECT t, p, cell, sign, e FROM observations
    WHERE market = ? AND t >= ? AND t < ? ORDER BY t
  `);
  const c = { origins: 0, invalidPhase: 0, purged: 0, noTarget: 0,
    lateTarget: 0, emaUnavailable: 0, accepted: 0, firstOrigin: Infinity, lastOrigin: -Infinity,
    firstTarget: Infinity, lastTarget: -Infinity };
  for (const raw of query.iterate(market, first, splitAt)) {
    const a = raw as Row;
    c.origins++;
    if (a.cell < 0) { c.invalidPhase++; continue; }
    if (a.t + HORIZON >= splitAt) { c.purged++; continue; }
    const b = target.after(a.t + HORIZON);
    if (!b) { c.noTarget++; continue; }
    if (b.t >= splitAt) { c.purged++; continue; }
    if (b.t - a.t - HORIZON > MAX_TARGET_DELAY) {
      c.lateTarget++; continue;
    }
    if (a.e == null || b.e == null) { c.emaUnavailable++; continue; }
    const value = a.sign * 1000 * (Math.log(b.e) - Math.log(a.e));
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
  readonly marketCount = new Uint32Array(STATE_COUNT);
  readonly largestMarketCount = new Float64Array(STATE_COUNT);
  readonly largestMarket = new Array<string>(STATE_COUNT).fill('');
  readonly positive = new Float64Array(STATE_COUNT);
  readonly min = new Float64Array(STATE_COUNT).fill(Infinity);
  readonly max = new Float64Array(STATE_COUNT).fill(-Infinity);
  readonly boundaryCrossings = new Float64Array(STATE_COUNT);
  private marketSamples = new Float64Array(STATE_COUNT);
  private lastTarget = new Float64Array(STATE_COUNT).fill(-Infinity);
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
    for (let i = 0; i < STATE_COUNT; i++) {
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
async function writeQuality(quality: CellQuality, cells: ReturnType<typeof newCells>,
  table: Float64Array, csv: Csv, blocks: Csv) {
  for (let cell = 0; cell < STATE_COUNT; cell++) {
    const n = cells.count[cell];
    if (!n) continue;
    const ns = quality.spaced.count[cell];
    const sd = n > 1 ? Math.sqrt(cells.m2[cell] / (n - 1)) : null;
    await csv.row([cell, Number.isFinite(table[cell]), n, cells.mean[cell], sd,
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
  const query = db.prepare(`SELECT t,p,cell,sign,e FROM observations
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
        this.stopPrice = this.strategy === null ? null :
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
      if (Number.isFinite(forecast) && forecast >= this.strategy.entry) {
        side = 'buy'; reason = 'entry-threshold';
      }
    } else {
      // Once an exit is triggered, missing execution data must not cancel it.
      // Reissue on a later tick after expiry, even if price/forecast recovers.
      if (this.exitIntent !== null) reason = this.exitIntent;
      else if (this.stopPrice !== null && row.p <= this.stopPrice) {
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
  'exitPermille', 'exitMode', 'targetMode', 'stopPermille',
  'feePermille', 'fullSpreadPermille', 'slipPerSidePermille',
  'initialCash', 'testTicks', 'validForecastTicks', 'invalidPhaseTicks',
  'missingCellTicks', 'firstTick', 'lastTick', 'terminalPriceAgeMs',
  'buys', 'sells', 'expiredOrders', 'unfilledAtEnd', 'openPosition',
  'closedWins', 'closedWinRate', 'closedProfitFactor', 'closedPnlQuote',
  'openLiquidationPnlQuote', 'finalCash', 'finalUnits',
  'finalLiquidationEquity', 'netReturnPct', 'maxDrawdownPct',
  'buyHoldReturnPct', 'excessOverBuyHoldPctPoints',
  'executedFeesQuote', 'estimatedTerminalExitFeeQuote', 'turnoverQuote',
  'meanClosedHoldingMs', 'openHoldingMs', 'exposureFractionObservedPeriod',
  'targetExits', 'stopExits', 'forecastExits',
];

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
  onOrder?: (s: Simulation, e: OrderEvent) => void) {
  const simulations = COSTS.flatMap((cost) =>
    [...STRATEGIES, null].map((strategy) => new Simulation(strategy, cost)));
  const query = db.prepare(`
    SELECT t, p, cell, sign, e FROM observations
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
    const baseline = simulations.find((b) => b.cost.id === s.cost.id &&
      b.strategy === null)!;
    const baselineReturn = price === undefined ? null :
      100 * (baseline.equity(price) / INITIAL_CASH - 1);
    const elapsed = s.last && s.first ? s.last.t - s.first.t : 0;
    await summary.row([
      market.name, s.id, s.cost.id, HORIZON, s.strategy?.entry,
      s.strategy?.exit, s.strategy?.exitMode ?? 'buy-and-hold',
      s.strategy?.targetMode, s.strategy?.stopPermille,
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
      s.targetExits, s.stopExits, s.forecastExits,
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
  const ticks = db.prepare(`SELECT t,p,cell,sign,e FROM observations
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
  const lookup = db.prepare(`SELECT t,p,cell,sign,e FROM observations
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
  return { rawReturn, emaReturn, originGap, targetGap, constant60,
    constantTarget, residual: emaReturn - constantTarget,
    forecastExcess: forecast - constant60,
    forecastError: forecast - emaReturn,
    baselineError: constant60 - emaReturn, flat60, flatTarget };
}
const LAG_KEYS = ['rawReturn', 'emaReturn', 'originGap', 'targetGap',
  'constant60', 'constantTarget', 'residual', 'forecastExcess'] as const;
const LAG_SUMMARY_HEADERS = [
  'market', 'direction', 'absForecastThreshold', 'validTargets',
  'meanForecastPermille',
  ...LAG_KEYS.map((key) => `mean_${key}_permille`),
  'forecastMAEPermille', 'constantPriceMAEPermille',
  'forecastRMSEPermille', 'constantPriceRMSEPermille',
  'constantPriceCorrectDirection', 'meanTargetDelayMs',
];
const LAG_SIGNAL_HEADERS = [
  'market', 'signalAt', 'targetAt', 'targetDelayMs', 'cell', 'speedSign',
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
  start: number, end: number, csv: Csv, basis: 'ema' | 'raw',
  lagSummary?: Csv, lagSignals?: Csv) {
  const groups = [-1, 1].flatMap((sign) => [0, 1, 2, 2.5, 3, 3.5, 4].map(
    (threshold) => ({ sign, threshold, samples: 0, counts: [0, 0, 0, 0],
      unavailable: 0, forecast: 0, actual: 0, correct: 0, wrong: 0, flat: 0,
      lag: new Float64Array(LAG_KEYS.length), forecastAbs: 0, baselineAbs: 0,
      forecastSq: 0, baselineSq: 0, baselineCorrect: 0, delay: 0 })));
  const reader = new Reader(db, market.id, start - 1);
  const query = db.prepare(`SELECT t,p,cell,sign,e FROM observations
    WHERE market=? AND t>=? AND t<=? ORDER BY t`);
  for (const raw of query.iterate(market.id, start, end)) {
    const r = raw as Row;
    const f = r.cell < 0 ? NaN : table[r.cell] * r.sign;
    if (!Number.isFinite(f) || f === 0) continue;
    const due = r.t + HORIZON;
    const label = labelAt(due > end ? null : reader.after(due), due, end);
    const lm = basis === 'ema' && label.status === 'valid' &&
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
      const actual = basis === 'ema' ? logReturn(r.e!, label.row!.e!) :
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
        g.baselineCorrect += Number(lm.constant60 * lm.emaReturn > 0);
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
    if (basis === 'ema' && lagSummary) {
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

async function main() {
  const { CANDLE_NAME } = await import('../../shared/constants/storage-entities.js');
  const { Storage } = await import('../../shared/services/storage.js');
  const { decodeEntireBinary } = await import(
    '../../shared/utilities/codecs/entire-binary-codec.js');
  const { q } = await import('../db/client.js');
  const { entityManager } = await import('../services/entity-manager.js');
  const { serverGlobalStateService } = await import('../services/global-state.js');
  for (const s of STRATEGIES) {
    if (s.exit !== null && !(s.entry > s.exit)) throw new Error('Entry must exceed exit');
  }
  for (const c of COSTS) {
    if (![c.fee, c.spread, c.slip].every(Number.isFinite) ||
      c.fee < 0 || c.fee >= 1000 || c.spread < 0 || c.slip < 0) {
      throw new Error(`Invalid cost scenario: ${c.id}`);
    }
  }
  await mkdir(OUTPUT, { recursive: true });
  const directory = await mkdtemp(resolve(OUTPUT, 'run-'));
  const cache = resolve(directory, 'observations.sqlite');
  const db = new DatabaseSync(cache);
  const files: Csv[] = [];
  const started = Date.now();
  try {
    db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -32768;
      PRAGMA temp_store = FILE;
      CREATE TABLE observations (
        market INTEGER NOT NULL, t INTEGER NOT NULL,
        p REAL NOT NULL, cell INTEGER NOT NULL, sign INTEGER NOT NULL,
        PRIMARY KEY (market, t)
      ) WITHOUT ROWID;
    `);
    const insert = db.prepare(`
      INSERT INTO observations VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (market, t) DO UPDATE SET
        p = excluded.p, cell = excluded.cell, sign = excluded.sign
    `);
    serverGlobalStateService.start();
    entityManager.start();
    const markets: Market[] = [];
    let rejectedRows = 0;
    let snapshots = 0;
    let largestSnapshot = 0;
    // One stable, read-only PostgreSQL snapshot for the complete extraction.
    await q.begin(async (sql) => {
      await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      const rows = await sql<Omit<Market, 'id'>[]>`
        SELECT name, stock, money FROM markets
        WHERE type = 'spot' AND EXISTS (
          SELECT 1 FROM storage_archive WHERE market_name = markets.name
        ) ORDER BY name
      `;
      const [size] = await sql<{ bytes: number }[]>`
        SELECT coalesce(max(octet_length(a.data)), 0) AS bytes
        FROM storage_archive a JOIN markets m ON m.name = a.market_name
        WHERE m.type = 'spot'
      `;
      largestSnapshot = Number(size.bytes);
      if (largestSnapshot > MAX_BLOB) {
        throw new Error('Snapshot exceeds MF_MAX_SNAPSHOT_MB; extraction stopped');
      }
      for (const [id, market] of rows.entries()) {
        markets.push({ ...market, id });
        for await (const batch of sql<{ data: Uint8Array }[]>`
          SELECT data FROM storage_archive WHERE market_name = ${market.name}
          ORDER BY ended_at
        `.cursor(1)) {
          for (const row of batch) {
            snapshots++;
            const entire = decodeEntireBinary(row.data);
            const storage = new Storage(market.name);
            storage.applySnapshot({ codecName: entire.codecName, data: entire.data });
            const accessors = storage.getAccessors();
            const candles = accessors.candles[CANDLE_NAME] as LazyArray<MarketCandle>;
            const phases = accessors.indicators[PHASE_NAME] as
              LazyArray<MarketPhaseValue> | undefined;
            for (let start = storage.levelBoundaries[0];
              start < storage.size; start += PAGE) {
              db.exec('BEGIN');
              try {
                for (let i = start; i < Math.min(start + PAGE, storage.size); i++) {
                  const candle = candles.get(i);
                  const phase = phases?.get(i);
                  if (!Number.isSafeInteger(candle.receivedAt) ||
                    !Number.isFinite(candle.price) || candle.price <= 0) {
                    rejectedRows++;
                    continue;
                  }
                  if (DATA_END !== null && candle.receivedAt > DATA_END) continue;
                  const cell = phase ? phaseCell(phase) : -1;
                  insert.run(id, candle.receivedAt, candle.price, cell,
                    cell < 0 ? 0 : Math.sign(phase!.speed));
                }
                db.exec('COMMIT');
              } catch (error) {
                db.exec('ROLLBACK');
                throw error;
              }
            }
          }
        }
        console.log(`Extracted ${id + 1}/${rows.length}: ${market.name}`);
      }
    });
    db.exec('ALTER TABLE observations ADD COLUMN e REAL');
    const fingerprint = createHash('sha256');
    let emaReady = 0;
    let emaWarmup = 0;
    for (const market of markets) {
      fingerprint.update(JSON.stringify(market.name) + '\n');
      const c = smoothMarket(db, market.id, fingerprint);
      emaReady += c.ready;
      emaWarmup += c.warmup;
      console.log(`EMA: ${market.name}, ready=${c.ready}, warmup=${c.warmup}`);
    }
    const observationsSha256 = fingerprint.digest('hex');
    const range = db.prepare(`
      SELECT min(t) AS first, max(t) AS last, count(*) AS n FROM observations
    `).get() as { first: number | null; last: number | null; n: number };
    if (range.first === null || range.last === null) throw new Error('No ticks');
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
    const eligible = markets.filter((m) => m.money === BASE_CURRENCY &&
      m.stock !== BASE_CURRENCY);
    for (const name of requestedNames) {
      if (!eligible.some((m) => m.name === name)) {
        throw new Error(`No archived spot market quoted in ${BASE_CURRENCY}: ${name}`);
      }
    }
    const selected = eligible.filter((m) => !requestedNames.length ||
      requestedNames.includes(m.name));
    if (!selected.length) throw new Error('No markets selected for simulation');
    async function output(name: string, headers: string[]) {
      const csv = await Csv.create(resolve(directory, name), headers);
      files.push(csv);
      return csv;
    }
    const trainCoverage = await output('training.csv', [
      'market', 'origins', 'invalidPhase', 'purged', 'noTarget', 'lateTarget',
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
      console.log(`Training: ${market.name}, samples=${c.accepted}`);
    }
    const table = Float64Array.from(cells.mean, (mean, i) =>
      cells.count[i] >= MIN_TRAIN_SAMPLES ? mean : NaN);
    if (!table.some(Number.isFinite)) throw new Error('No usable trained cells');
    assert.ok(lastTrainTarget < splitAt);
    const cellQuality = await output('cell-quality.csv', [
      'cell', 'forecastEnabled', 'trainSamples', 'alignedMeanPermille',
      'sampleStdDevPermille', 'minPermille', 'maxPermille', 'positiveFraction',
      'trainingMarkets', 'largestMarket', 'largestMarketSampleShare',
      'nonOverlappingSamples', 'nonOverlappingAlignedMeanPermille',
      'nonOverlappingStdDevPermille', 'blockBoundaryPurged', 'flags',
    ]);
    const blockQuality = await output('cell-time-blocks.csv', [
      'cell', 'block', 'startInclusive', 'endExclusive', 'samples',
      'alignedMeanPermille', 'sampleStdDevPermille', 'enoughBlockSamples',
    ]);
    await writeQuality(quality, cells, table, cellQuality, blockQuality);
    const signalQuality = await output('signal-quality.csv', [
      'market', 'signalAt', 'signalPrice', 'cell', 'speedSign', 'forecastPermille',
      'trainSamples', 'nonOverlappingSamples', 'flags',
      ...Array.from({ length: QUALITY_BLOCKS }, (_, i) =>
        [`block${i + 1}Samples`, `block${i + 1}NaturalMeanPermille`]).flat(),
    ]);
    const frozen = JSON.stringify({
      version: 2, source: 'current archive, chronological training',
      observationsSha256, targetDefinition: TARGET_DEFINITION, phaseName: PHASE_NAME, horizonMs: HORIZON,
      responseTimeMs: RESPONSE_TIME, tauMinutes: TAU,
      splitAt: new Date(splitAt).toISOString(), trainSamples,
      lastTrainTarget: new Date(lastTrainTarget).toISOString(),
      minTrainSamples: MIN_TRAIN_SAMPLES,
      trainingMarkets: markets, tradingMarkets: selected.map((m) => m.name),
      coordinate: 'aligned to sign(speed); permille log-return',
      target: 'first tick >= origin+horizon, delay <= maxTargetDelayMs, target < splitAt',
      maxTargetDelayMs: MAX_TARGET_DELAY,
      bins: { speed: SPEED_BINS, acceleration: ACCEL_BINS, surprise: SURPRISE_BINS },
      layout: '(speedIndex * accelerationCount + accelerationIndex) * surpriseCount + surpriseIndex',
      mean: Array.from(table), count: Array.from(cells.count),
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
    const lagSummary = await output('ema-lag-summary.csv', LAG_SUMMARY_HEADERS);
    const lagSignals = await output('ema-lag-signals.csv', LAG_SIGNAL_HEADERS);
    const recordAttempt = attemptRecorder(db);
    for (const market of selected) {
      db.exec('DELETE FROM buy_attempts; BEGIN');
      try {
        await replay(db, market, table, start, end, summary, orders, equity, recordAttempt);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      await diagnostics(db, market, table, start, end, diagnosticSummary, buyAttempts);
      await writeSignalQuality(db, market, table, cells, quality, start, end, signalQuality);
      await calibrate(db, market, table, start, end, calibration, 'ema',
        lagSummary, lagSignals);
      await calibrate(db, market, table, start, end, calibration, 'raw');
      console.log(`Simulated: ${market.name}`);
    }
    while (files.length) await files.pop()!.close();
    await writeFile(resolve(directory, 'metadata.json'), JSON.stringify({
      version: 8, status: 'complete', generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started, baseCurrency: BASE_CURRENCY,
      initialCashPerMarketAndScenario: INITIAL_CASH,
      observations: range, snapshots, rejectedRows,
      targetDefinition: TARGET_DEFINITION, emaReady, emaWarmup,
      dataEnd: DATA_END, observationsSha256,
      fingerprint: 'SHA256 of ordered market names and deduplicated [t,p,cell,sign]; excludes EMA',
      emaLag: {
        summary: 'ema-lag-summary.csv: all calibration cohorts, identical valid labels',
        detail: 'ema-lag-signals.csv: valid test labels with abs(forecast)>=2; both signs; once per origin',
        gap: '1000*ln(raw/EMA); emaReturn=rawReturn+originGap-targetGap',
        constantPrice: 'Eflat(dt)=P0+(E0-P0)*exp(-dt/tau)',
        baseline: 'constantPrice60sReturn uses only origin data; compare its MAE/RMSE with forecast on the same EMA outcomes',
        matchedTime: 'constantPriceTargetReturn uses actual selected target elapsed time (60-70s), retrospective decomposition only',
        residual: 'emaReturn-constantPriceTargetReturn; not an executable return',
        interpretation: 'diagnostic only; does not change table training or strategy signals',
      },
      largestSnapshotBytes: largestSnapshot, trainingMarkets: markets.length,
      tradingMarkets: selected.map((m) => m.name),
      splitAt: new Date(splitAt).toISOString(),
      testStart: new Date(start).toISOString(), testEnd: new Date(end).toISOString(),
      horizonMs: HORIZON, minTrainSamples: MIN_TRAIN_SAMPLES,
      trainSamples, lastTrainTarget, tableSha256: tableHash,
      strategies: STRATEGIES, costs: COSTS, latencyMs: LATENCY,
      maxFillWaitMs: MAX_FILL_WAIT, maxHoldMs: null,
      equityIntervalMs: EQUITY_INTERVAL,
      costUnits: 'permille; fee=1 means 0.1% on executed notional per side',
      costsSource: 'explicit assumed scenarios; not exchange/account fee history',
      priceModel: 'last trade used as midpoint proxy; buy=P*exp((spread/2+slip)/1000), sell=P/exp((spread/2+slip)/1000)',
      feeModel: 'quote-equivalent fee; buy qty=cash/(executionPrice*(1+feeRate)); sell cash=qty*executionPrice*(1-feeRate)',
      execution: 'first subsequent tick at or after signal+latency, at most maxFillWaitMs later; otherwise modeled order expires without fill',
      executionLimitation: 'expiry represents unavailable execution data, not actual exchange rejection; fills are hypothetical, all-or-none, unlimited liquidity',
      omittedRules: 'no order-book depth, partial fills, quantity rounding, min notional/amount, historical listing/trading restrictions or account fee tiers',
      targets: 'fixed at buy fill: threshold or forecast from original buy signal; never updated by subsequent forecasts',
      levels: 'log-return permille, target=buyExecutionPrice*exp(targetPermille/1000), stop=buyExecutionPrice*exp(-entryThreshold*0.5/1000); trigger against observed raw price; subsequent sell execution also applies spread/slip and fees',
      exitPriority: 'latched exit retry first; otherwise protective stop, target, forecast<=0; each triggers a market sell subject to latency and data availability, never guaranteed execution at a level',
      expiredExit: 'once triggered, an exit remains latched until filled; after expiry reissue on the next tick, even if price or forecast recovers; original exit reason preserved',
      comparison: 'independent inventories; exits change subsequent entries; cost scenarios can have different exit times because levels are anchored to their own buy execution prices',
      maxHoldScope: 'no maximum holding time; MF_MAX_HOLD_MS is ignored in v8',
      strategy: 'spot long/cash, one position and one pending order; signal checked on each received tick; missing forecast disables only forecast exit; targets and stops remain active; no short sales',
      horizon: 'rolling next-minute forecast; positions need not last one minute',
      baseline: 'buy-and-hold starts at first test tick and uses same latency/cost/expiry model; expired entry retries on a later tick; USDT cash baseline is 0%',
      terminal: 'positions remain open; final equity includes hypothetical sell spread, slip and fee at last observed price; no forced terminal fill',
      drawdown: 'peak-to-trough liquidation equity evaluated on every archived test tick, including initial cash as initial peak',
      coverage: 'market first/last ticks and terminal price age are reported; long gaps and sparse data can bias execution and valuation',
      interpretation: 'each market/scenario has independent capital; no combined portfolio; do not choose winners on this test and call that out-of-sample',
      validation: 'chronological holdout for this run; historical stored phases, not a full causal indicator replay; period may have been inspected previously',
      extraction: 'all archived spot markets, raw level 0, including unchanged ticks; last archive value wins duplicate market/timestamp',
      cellQuality: {
        mode: 'diagnostic only; no extra entry filter; all 25 strategies unchanged',
        refit: 'table retrained every run, frozen only within that run',
        minSamplesFlag: QUALITY_MIN_SAMPLES,
        blocks: QUALITY_BLOCKS, minBlockSamples: QUALITY_MIN_BLOCK_SAMPLES,
        periods: 'equal-duration global training blocks; origins and actual targets must both fall within block; crossing targets excluded from block statistics only',
        units: 'cell and block returns aligned to speed sign; signal block means converted to natural market direction',
        nonOverlapping: 'greedy per market and cell, next origin >= previous accepted actual target; not a count of independent events; cross-market dependence remains',
        dispersion: 'sample standard deviation describes outcome dispersion, not confidence of mean; no IID confidence interval claimed',
        flags: 'heuristic descriptions, not a statistical guarantee; no-listed-flags does not certify reliability; computed exclusively from training',
        signalJoin: 'signal-quality records all forecastable test ticks >= smallest entry threshold, independent of inventory; join attempts/orders on market and signalAt',
      },
      calibration: 'paired EMA and raw returns on the same valid test labels; forecast predicts EMA change, not executable raw return; warmup labels excluded from both',
      diagnostics: {
        units: 'gross permille log returns using raw reference prices, excluding execution costs',
        timing: 'retrospective only, computed after replay; no labels feed trading decisions',
        target: 'first tick >= origin+60000ms, at most 10000ms late and within testEnd',
        cohorts: 'all-positive-ticks at each entry threshold; zero-cost-control buy attempts grouped by strategy and resolution status, including failed and still-open entries',
        weighting: 'equal weight per tick or attempt within each market; overlapping horizons and repeated ticks are dependent observations, not independent trials; thresholds overlap',
        common: 'all five component means and meanForecastCommon use exactly the same filled attempts with both valid targets',
        identities: 'signalToTarget = signalToFill + fillToSignalTarget; fillToFillTarget = fillToSignalTarget + endpointShift',
        missing: 'blank metrics are unavailable, never zero; late target times/prices retained for coverage only; no-target includes missing observations before testEnd',
        files: ['diagnostic-summary.csv', 'buy-attempts.csv'],
      },
      memory: '32 MiB SQLite cache plus bounded pages, one decoded snapshot, fixed training arrays and 104 simulation states per market; files written sequentially',
    }, null, 2) + '\n');
    console.log(`Results: ${directory}`);
  } finally {
    await Promise.allSettled(files.map((file) => file.close()));
    db.close();
    if (process.env.MF_KEEP_CACHE !== '1') {
      await rm(cache, { force: true });
      await rm(`${cache}-journal`, { force: true });
    }
    await q.end();
  }
}
async function selfTest() {
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
  assert.equal(lag.forecastExcess, alteredTarget.forecastExcess);
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
  assert.equal(STRATEGIES.length, 25);
  assert.equal(new Set(STRATEGIES.map((x) => x.id)).size, 25);
  for (const strategy of STRATEGIES) {
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
      market INTEGER, t INTEGER, p REAL, cell INTEGER, sign INTEGER,
      PRIMARY KEY(market, t)
    ) WITHOUT ROWID`);
    const insert = db.prepare('INSERT INTO observations VALUES (?, ?, ?, ?, ?)');
    for (let t = 0; t <= 200_000; t += 1000) {
      insert.run(0, t, 100 * Math.exp(t / 10_000_000), 0, t < 160_000 ? 1 : -1);
    }
    db.exec('ALTER TABLE observations ADD COLUMN e REAL');
    smoothMarket(db, 0);
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
    const endpoints = db.prepare('SELECT t,e,p FROM observations ORDER BY t')
      .all() as { t: number; e: number | null; p: number }[];
    const expected = endpoints.slice(warmupTicks, 60).reduce((sum, a) =>
      sum + 1000 * Math.log(endpoints[a.t / 1000 + 60].e! / a.e!), 0) / Math.max(1, 60 - warmupTicks);
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
    const table = new Float64Array(STATE_COUNT).fill(NaN);
    table[0] = 3.7;
    const recorder = attemptRecorder(db);
    try {
      await replay(db, { id: 0, name: 'A_USDT', stock: 'A', money: 'USDT' },
        table, 120_000, 200_000, summary, orders, equity, recorder);
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
        table, 120000, 200000, calibrationFile, 'ema', lagFile, lagDetail);
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
    const emaUp = calibrationRows.find((r) => r.priceBasis === 'ema' &&
      r.direction === 'up' && r.absForecastThreshold === '2')!;
    assert.equal(Number(emaUp.validTargets), Number(up.validTargets));
    assert.ok(Number(emaUp.meanActualPermille) > 5.99);
    const lagRows = parse(await readFile(resolve(directory, 'lag.csv'), 'utf8'));
    const lagUp = lagRows.find((r) => r.direction === 'up' && r.absForecastThreshold === '2')!;
    assert.equal(Number(lagUp.validTargets), Number(emaUp.validTargets));
    assert.ok(Math.abs(Number(lagUp.mean_emaReturn_permille) -
      Number(emaUp.meanActualPermille)) < 1e-10);
    const lagDetails = parse(await readFile(resolve(directory, 'lag-detail.csv'), 'utf8'));
    assert.equal(lagDetails.length, 21);
    for (const r of lagDetails) {
      assert.ok(Math.abs(Number(r.emaReturnPermille) - Number(r.rawReturnPermille) -
        Number(r.originGapPermille) + Number(r.targetGapPermille)) < 1e-10);
      assert.ok(Number(r.priceOrigin) !== Number(r.emaOrigin));
    }
    const errorMean = lagDetails.reduce((sum, r) => sum +
      Math.abs(Number(r.forecastPermille) - Number(r.emaReturnPermille)), 0) / lagDetails.length;
    assert.ok(Math.abs(errorMean - Number(lagUp.forecastMAEPermille)) < 1e-10);
    const summaries = parse(await readFile(resolve(directory, 'summary.csv'), 'utf8'));
    assert.equal(summaries.length, COSTS.length * (STRATEGIES.length + 1));
    for (const r of summaries) {
      assert.equal(Number(r.testTicks), 81);
      assert.equal(Number(r.validForecastTicks), 81);
      assert.ok(Math.abs(Number(r.finalLiquidationEquity) - INITIAL_CASH -
        Number(r.closedPnlQuote) - Number(r.openLiquidationPnlQuote)) < 1e-8);
      if (r.strategy.startsWith('entry-4-')) assert.equal(Number(r.buys), 0);
      assert.equal(Number(r.sells), Number(r.targetExits) + Number(r.stopExits) +
        Number(r.forecastExits));
    }
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
    console.log('v8: EMA lag identity, constant-price control and parameterized tau.');
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

void (process.argv.includes('--self-test') ? selfTest() : main())
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
