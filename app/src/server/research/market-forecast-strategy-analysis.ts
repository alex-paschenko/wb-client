// app/src/server/research/market-forecast-strategy-analysis.ts
// Research only: local simulation, no exchange order submission.
// Run from app with node --import tsx; append --self-test for offline tests.
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
const MAX_HOLD = integer('MF_MAX_HOLD_MS', 0, 0, 86_400_000);
const EQUITY_INTERVAL = 300_000;
const MAX_BLOB = integer('MF_MAX_SNAPSHOT_MB', 64, 1, 1024) * 1024 ** 2;
const REQUESTED_SPLIT = dateEnv('MF_SPLIT_AT');
const REQUESTED_START = dateEnv('MF_TEST_START');
const REQUESTED_END = dateEnv('MF_TEST_END');
const OUTPUT = resolve('research-output/market-forecast-strategy-v1');
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
const STRATEGIES = [
  { id: 'entry-1', entry: 1, exit: 0.25 },
  { id: 'entry-2', entry: 2, exit: 0.25 },
  { id: 'entry-3', entry: 3, exit: 0.25 },
];

type Cost = typeof COSTS[number];
type Strategy = typeof STRATEGIES[number];
type Market = { id: number; name: string; stock: string; money: string };
type Row = { t: number; p: number; cell: number; sign: number };

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
      SELECT t, p, cell, sign FROM observations
      WHERE market = ? AND t > ? ORDER BY t LIMIT ${PAGE}
    `);
    this.market = market;
    const seed = db.prepare(`
      SELECT t, p, cell, sign FROM observations
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
  splitAt: number, cells: ReturnType<typeof newCells>) {
  const target = new Reader(db, market, first);
  const query = db.prepare(`
    SELECT t, p, cell, sign FROM observations
    WHERE market = ? AND t >= ? AND t < ? ORDER BY t
  `);
  const c = { origins: 0, invalidPhase: 0, purged: 0, noTarget: 0,
    lateTarget: 0, accepted: 0, firstOrigin: Infinity, lastOrigin: -Infinity,
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
    const value = a.sign * 1000 * (Math.log(b.p) - Math.log(a.p));
    const n = ++cells.count[a.cell];
    const delta = value - cells.mean[a.cell];
    cells.mean[a.cell] += delta / n;
    cells.m2[a.cell] += delta * (value - cells.mean[a.cell]);
    c.accepted++;
    c.firstOrigin = Math.min(c.firstOrigin, a.t);
    c.lastOrigin = Math.max(c.lastOrigin, a.t);
    c.firstTarget = Math.min(c.firstTarget, b.t);
    c.lastTarget = Math.max(c.lastTarget, b.t);
  }
  return c;
}

type Pending = { side: 'buy' | 'sell'; reason: string; t: number;
  due: number; p: number; f: number | null };
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
    } else if (MAX_HOLD > 0 && row.t - this.entryAt >= MAX_HOLD) {
      side = 'sell'; reason = 'max-hold';
    } else if (Number.isFinite(forecast) && forecast <= this.strategy.exit) {
      side = 'sell'; reason = 'forecast-faded';
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
];
const EQUITY_HEADERS = [
  'market', 'strategy', 'costScenario', 'at', 'referencePrice',
  'liquidationEquityQuote', 'cash', 'units', 'executedFeesQuote',
  'estimatedExitFeeQuote', 'forecastPermille',
];
const SUMMARY_HEADERS = [
  'market', 'strategy', 'costScenario', 'horizonMs', 'entryPermille',
  'exitPermille', 'feePermille', 'fullSpreadPermille', 'slipPerSidePermille',
  'initialCash', 'testTicks', 'validForecastTicks', 'invalidPhaseTicks',
  'missingCellTicks', 'firstTick', 'lastTick', 'terminalPriceAgeMs',
  'buys', 'sells', 'expiredOrders', 'unfilledAtEnd', 'openPosition',
  'closedWins', 'closedWinRate', 'closedProfitFactor', 'closedPnlQuote',
  'openLiquidationPnlQuote', 'finalCash', 'finalUnits',
  'finalLiquidationEquity', 'netReturnPct', 'maxDrawdownPct',
  'buyHoldReturnPct', 'excessOverBuyHoldPctPoints',
  'executedFeesQuote', 'estimatedTerminalExitFeeQuote', 'turnoverQuote',
  'meanClosedHoldingMs', 'openHoldingMs', 'exposureFractionObservedPeriod',
];

async function writeOrder(csv: Csv, market: string, s: Simulation, e: OrderEvent) {
  await csv.row([market, s.id, s.cost.id, e.order.side, e.order.reason, e.status,
    e.order.t, e.order.due, e.at, e.order.f, e.order.p, e.reference,
    e.execution, e.quantity, e.fee, e.pnl, e.holdingMs, s.cash, s.units]);
}

async function writeEquity(csv: Csv, market: string, s: Simulation, f: number) {
  if (!s.last) return;
  await csv.row([market, s.id, s.cost.id, s.last.t, s.last.p,
    s.equity(s.last.p), s.cash, s.units, s.fees,
    s.terminalExitFee(s.last.p), f]);
}

async function replay(db: DatabaseSync, market: Market, table: Float64Array,
  start: number, end: number, summary: Csv, orders: Csv, equity: Csv) {
  const simulations = COSTS.flatMap((cost) =>
    [...STRATEGIES, null].map((strategy) => new Simulation(strategy, cost)));
  const query = db.prepare(`
    SELECT t, p, cell, sign FROM observations
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
      if (event) await writeOrder(orders, market.name, s, event);
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
    if (event) await writeOrder(orders, market.name, s, event);
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
      s.strategy?.exit, s.cost.fee, s.cost.spread, s.cost.slip,
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
    ]);
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
    if (!(s.entry > s.exit)) throw new Error('Entry must exceed exit');
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
      'accepted', 'firstOrigin', 'lastOrigin', 'firstTarget', 'lastTarget',
    ]);
    const cells = newCells();
    let trainSamples = 0;
    let lastTrainTarget = -Infinity;
    for (const market of markets) {
      const c = fitMarket(db, market.id, range.first, splitAt, cells);
      trainSamples += c.accepted;
      lastTrainTarget = Math.max(lastTrainTarget, c.lastTarget);
      await trainCoverage.row([market.name, ...Object.values(c)]);
      console.log(`Training: ${market.name}, samples=${c.accepted}`);
    }
    const table = Float64Array.from(cells.mean, (mean, i) =>
      cells.count[i] >= MIN_TRAIN_SAMPLES ? mean : NaN);
    if (!table.some(Number.isFinite)) throw new Error('No usable trained cells');
    assert.ok(lastTrainTarget < splitAt);
    const frozen = JSON.stringify({
      version: 1, phaseName: PHASE_NAME, horizonMs: HORIZON,
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
    for (const market of selected) {
      await replay(db, market, table, start, end, summary, orders, equity);
      console.log(`Simulated: ${market.name}`);
    }
    while (files.length) await files.pop()!.close();
    await writeFile(resolve(directory, 'metadata.json'), JSON.stringify({
      version: 1, status: 'complete', generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started, baseCurrency: BASE_CURRENCY,
      initialCashPerMarketAndScenario: INITIAL_CASH,
      observations: range, snapshots, rejectedRows,
      largestSnapshotBytes: largestSnapshot, trainingMarkets: markets.length,
      tradingMarkets: selected.map((m) => m.name),
      splitAt: new Date(splitAt).toISOString(),
      testStart: new Date(start).toISOString(), testEnd: new Date(end).toISOString(),
      horizonMs: HORIZON, minTrainSamples: MIN_TRAIN_SAMPLES,
      trainSamples, lastTrainTarget, tableSha256: tableHash,
      strategies: STRATEGIES, costs: COSTS, latencyMs: LATENCY,
      maxFillWaitMs: MAX_FILL_WAIT, maxHoldMs: MAX_HOLD,
      equityIntervalMs: EQUITY_INTERVAL,
      costUnits: 'permille; fee=1 means 0.1% on executed notional per side',
      costsSource: 'explicit assumed scenarios; not exchange/account fee history',
      priceModel: 'last trade used as midpoint proxy; buy=P*exp((spread/2+slip)/1000), sell=P/exp((spread/2+slip)/1000)',
      feeModel: 'quote-equivalent fee; buy qty=cash/(executionPrice*(1+feeRate)); sell cash=qty*executionPrice*(1-feeRate)',
      execution: 'first subsequent tick at or after signal+latency, at most maxFillWaitMs later; otherwise modeled order expires without fill',
      executionLimitation: 'expiry represents unavailable execution data, not actual exchange rejection; fills are hypothetical, all-or-none, unlimited liquidity',
      omittedRules: 'no order-book depth, partial fills, quantity rounding, min notional/amount, historical listing/trading restrictions or account fee tiers',
      strategy: 'spot long/cash, one position and one pending order; signal checked on each received tick; missing forecast holds current state; no short sales',
      horizon: 'rolling next-minute forecast; positions need not last one minute',
      baseline: 'buy-and-hold starts at first test tick and uses same latency/cost/expiry model; expired entry retries on a later tick; USDT cash baseline is 0%',
      terminal: 'positions remain open; final equity includes hypothetical sell spread, slip and fee at last observed price; no forced terminal fill',
      drawdown: 'peak-to-trough liquidation equity evaluated on every archived test tick, including initial cash as initial peak',
      coverage: 'market first/last ticks and terminal price age are reported; long gaps and sparse data can bias execution and valuation',
      interpretation: 'each market/scenario has independent capital; no combined portfolio; do not choose winners on this test and call that out-of-sample',
      validation: 'chronological holdout for this run; historical stored phases, not a full causal indicator replay; period may have been inspected previously',
      extraction: 'all archived spot markets, raw level 0, including unchanged ticks; last archive value wins duplicate market/timestamp',
      memory: '32 MiB SQLite cache plus bounded pages, one decoded snapshot, fixed training arrays and 16 simulation states per market; files written sequentially',
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
  const row = (t: number, p: number): Row => ({ t, p, cell: 0, sign: 1 });
  const cost = COSTS.find((c) => c.id === 'moderate')!;
  const s = new Simulation(STRATEGIES[0], cost, 250, 2000);
  assert.equal(s.tick(row(0, 100), 2), null);
  assert.equal(s.buys, 0);
  assert.equal(s.tick(row(200, 100), 2), null);
  const buy = s.tick(row(250, 100), 2)!;
  assert.equal(buy.status, 'filled');
  assert.equal(buy.order.side, 'buy');
  assert.equal(s.cash, 0);
  const factor = Math.exp((cost.spread / 2 + cost.slip) / 1000);
  const fee = cost.fee / 1000;
  const qty = INITIAL_CASH / (100 * factor * (1 + fee));
  assert.ok(Math.abs(s.units - qty) < 1e-10);
  assert.ok(s.equity(100) < INITIAL_CASH);
  assert.ok(s.maxDrawdown > 0);
  assert.equal(s.tick(row(500, 110), NaN), null);
  assert.equal(s.pending, null);
  s.tick(row(600, 110), 0);
  assert.equal(s.sells, 0);
  const sell = s.tick(row(850, 110), -1)!;
  assert.equal(sell.order.side, 'sell');
  assert.equal(s.units, 0);
  const expected = INITIAL_CASH * 1.1 / factor ** 2 * (1 - fee) / (1 + fee);
  assert.ok(Math.abs(s.cash - expected) < 1e-9);
  assert.ok(Math.abs(s.closedPnl - (expected - INITIAL_CASH)) < 1e-9);
  assert.equal(s.closedHoldingMs, 600);
  assert.equal(s.exposedMs, 600);
  assert.equal(s.wins, 1);

  const expired = new Simulation(STRATEGIES[0], COSTS[0], 250, 2000);
  expired.tick(row(0, 100), 2);
  assert.equal(expired.tick(row(2251, 100), 2)?.status, 'expired-no-timely-tick');
  assert.equal(expired.buys, 0);
  assert.equal(expired.cash, INITIAL_CASH);
  const zeroLatency = new Simulation(STRATEGIES[0], COSTS[0], 0, 2000);
  zeroLatency.tick(row(0, 100), 2);
  assert.equal(zeroLatency.buys, 0);
  zeroLatency.tick(row(1, 100), 2);
  assert.equal(zeroLatency.buys, 1);
  zeroLatency.tick(row(2, 110), 0);
  assert.equal(zeroLatency.finish(3)?.status, 'unfilled-at-test-end');
  assert.equal(zeroLatency.sells, 0);
  assert.equal(zeroLatency.units, INITIAL_CASH / 100);
  assert.equal(zeroLatency.equity(110), 1100);
  assert.equal(zeroLatency.openPnl(110), 100);
  const negative = new Simulation(STRATEGIES[0], COSTS[0], 0, 2000);
  negative.tick(row(0, 100), -10);
  assert.equal(negative.pending, null);

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
    const before = newCells();
    const training = fitMarket(db, 0, 0, 120_000, before);
    assert.equal(training.accepted, 60);
    assert.equal(training.purged, 60);
    assert.equal(training.lastTarget, 119_000);
    assert.ok(Math.abs(before.mean[0] - 6) < 1e-10);
    db.exec('UPDATE observations SET p=p*10 WHERE t>=120000');
    const after = newCells();
    assert.deepEqual(fitMarket(db, 0, 0, 120_000, after), training);
    assert.deepEqual(after, before);
    db.exec('UPDATE observations SET p=p/10 WHERE t>=120000');

    const summary = await Csv.create(resolve(directory, 'summary.csv'), SUMMARY_HEADERS);
    const orders = await Csv.create(resolve(directory, 'orders.csv'), ORDER_HEADERS);
    const equity = await Csv.create(resolve(directory, 'equity.csv'), EQUITY_HEADERS);
    const table = new Float64Array(STATE_COUNT).fill(NaN);
    table[0] = 2;
    try {
      await replay(db, { id: 0, name: 'A_USDT', stock: 'A', money: 'USDT' },
        table, 120_000, 200_000, summary, orders, equity);
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
    const summaries = parse(await readFile(resolve(directory, 'summary.csv'), 'utf8'));
    assert.equal(summaries.length, COSTS.length * (STRATEGIES.length + 1));
    for (const r of summaries) {
      assert.equal(Number(r.testTicks), 81);
      assert.equal(Number(r.validForecastTicks), 81);
      assert.ok(Math.abs(Number(r.finalLiquidationEquity) - INITIAL_CASH -
        Number(r.closedPnlQuote) - Number(r.openLiquidationPnlQuote)) < 1e-8);
      if (r.strategy === 'entry-3') assert.equal(Number(r.buys), 0);
    }
    const events = parse(await readFile(resolve(directory, 'orders.csv'), 'utf8'));
    for (const e of events.filter((e) => e.status === 'filled')) {
      assert.ok(Number(e.resolvedAt) > Number(e.signalAt));
      assert.ok(Number(e.resolvedAt) >= Number(e.eligibleAt));
      assert.ok(Number(e.resolvedAt) <= Number(e.eligibleAt) + MAX_FILL_WAIT);
    }
    const control = summaries.find((r) => r.strategy === 'entry-1' &&
      r.costScenario === 'zero-cost-control')!;
    if (LATENCY === 250 && MAX_FILL_WAIT === 2000 && MAX_HOLD === 0) {
      assert.equal(Number(control.buys), 1);
      assert.equal(Number(control.sells), 1);
      assert.ok(Number(control.netReturnPct) > 0);
    }
    parse(await readFile(resolve(directory, 'equity.csv'), 'utf8'));
    console.log('Self-test passed: chronological training, future-data isolation,');
    console.log('delayed fills, costs, expiry, inventory, terminal valuation and CSV replay.');
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
