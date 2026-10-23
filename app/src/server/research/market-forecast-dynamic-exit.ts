// app/src/server/research/market-forecast-dynamic-exit.ts
// Run from app: node --import tsx src/server/research/market-forecast-dynamic-exit.ts
// Read-only SQLite research; frozen forecast tables are NOT retrained.

import { readdir, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MARKET_FORECAST_3_EMA,
  MARKET_FORECAST_4_EMA,
  MARKET_FORECAST_ALIGNED_BINS,
  MARKET_FORECAST_SLOW_BINS,
  MARKET_FORECAST_CURVATURE_BINS,
  MARKET_FORECAST_PAIR_BINS,
  MARKET_FORECAST_COMBINED_CORRECTION,
} from '../constants/market-forecast-table.js';

// Choose a specific file here, or use the latest finished cache automatically.
const CACHE_PATH: string | null = null;
const CACHE_DIR = resolve('research-output/market-research-cache');
const OUTPUT_DIR = resolve('research-output/market-forecast-dynamic-exit');

// This cutoff is the end of the cache used to generate the frozen tables.
// Data up to and including this timestamp is ONLY used to warm up EMAs.
const FROZEN_TABLE_END_ISO = '2026-10-02T01:40:49.395Z';
const VALIDATION_FRACTION = 0.5;
const QUOTE_CURRENCIES = ['USD','USDT'];
const MARKET_NAMES: string[] = []; // Empty means all eligible spot markets.

const ENTRY_THRESHOLDS = [2, 2.5, 3, 3.5, 4, 5] as const;
const EXIT_THRESHOLDS = [
  -2, -1.5, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5,
] as const;

// Same fixed round-trip costs for every market, for comparable experiments.
// 1 permille per side means a 2 permille round-trip fee before slippage.
const FEE_PER_SIDE_PERMILLE = 1;
const SLIPPAGE_PER_SIDE_PERMILLE = 0;
const MAX_SIGNAL_TO_FILL_MS = 10_000;
const MAX_TICK_GAP_MS = 60_000;
const DECISION_INTERVAL_MS = 1_000; // Set to 0 to evaluate every tick.

const TAUS_MS = [7_000, 15_000, 30_000, 60_000] as const;
const DIRECT_WARMUP_MS = 150_000;
const DERIVED_WARMUP_MS = 300_000;
const MIN_NEW_DATA_MS = 60 * 60_000;
const FROZEN_END = Date.parse(FROZEN_TABLE_END_ISO);

type Tick = { t: number; p: number };
type Market = { id: number; name: string; money: string };
type Side = -1 | 1;
type Period = 'validation' | 'test';
type Pending = { action: 'enter' | 'exit'; side: Side; at: number };
type Position = {
  side: Side;
  enteredAt: number;
  entryPrice: number;
  mfe: number;
  mae: number;
};
type Combo = { entry: number; exit: number };
type CloseReason = 'signal' | 'gap' | 'end';

type Stats = {
  trades: number;
  wins: number;
  gross: number;
  net: number;
  mfe: number;
  mae: number;
  durationMs: number;
  signalCloses: number;
  gapCloses: number;
  endCloses: number;
  maxMarketDrawdown: number;
};

type Runner = {
  position: Position | null;
  pending: Pending | null;
  equity: number[];
  peak: number[];
};

const COMBOS: Combo[] = ENTRY_THRESHOLDS.flatMap((entry) =>
  EXIT_THRESHOLDS.map((exit) => ({ entry, exit })));

const COST_PER_ROUNDTRIP = (() => {
  const f = FEE_PER_SIDE_PERMILLE / 1000;
  const s = SLIPPAGE_PER_SIDE_PERMILLE / 1000;
  if (f < 0 || f >= 1 || s < 0 || s >= 1) {
    throw new Error('Invalid fee/slippage');
  }
  // Exact log cost for symmetric buy/sell fees and execution slippage.
  return 1000 * (Math.log1p(f) - Math.log1p(-f) +
    Math.log1p(s) - Math.log1p(-s));
})();

function stats(): Stats {
  return {
    trades: 0, wins: 0, gross: 0, net: 0, mfe: 0, mae: 0,
    durationMs: 0, signalCloses: 0, gapCloses: 0, endCloses: 0,
    maxMarketDrawdown: 0,
  };
}

function addStats(to: Stats, from: Stats): void {
  for (const key of [
    'trades', 'wins', 'gross', 'net', 'mfe', 'mae', 'durationMs',
    'signalCloses', 'gapCloses', 'endCloses',
  ] as const) to[key] += from[key];
  to.maxMarketDrawdown = Math.max(
    to.maxMarketDrawdown, from.maxMarketDrawdown);
}

function bin(value: number, bounds: readonly number[]): number {
  for (let i = 0; i < bounds.length; i++) {
    if (value < bounds[i]) return i;
  }
  return bounds.length;
}

// Matches MarketForecastIndicator.predict() (v6 frozen tables).
class Forecast {
  private readonly emas = new Float64Array(TAUS_MS.length);
  private first = NaN;
  private previous = NaN;

  update(t: number, price: number): number | null {
    if (!(price > 0) || !Number.isFinite(price)) {
      throw new Error('Invalid cached price');
    }
    const x = 1000 * Math.log(price);
    if (!Number.isFinite(this.previous)) {
      this.emas.fill(x);
      this.first = t;
    } else {
      if (t <= this.previous) throw new Error('Non-increasing timestamps');
      const dt = t - this.previous;
      for (let i = 0; i < TAUS_MS.length; i++) {
        this.emas[i] += -Math.expm1(-dt / TAUS_MS[i]) *
          (x - this.emas[i]);
      }
    }
    this.previous = t;
    const v = TAUS_MS.map((tau, i) =>
      (x - this.emas[i]) / (tau / 60_000));
    const age = t - this.first;
    let direct: number | null = null;
    let derived: number | null = null;

    if (age >= DIRECT_WARMUP_MS && v[2] !== 0) {
      const sign = Math.sign(v[2]);
      const cell = (bin(v[0] * sign, MARKET_FORECAST_ALIGNED_BINS) *
        (MARKET_FORECAST_ALIGNED_BINS.length + 1) +
        bin(v[1] * sign, MARKET_FORECAST_ALIGNED_BINS)) *
        (MARKET_FORECAST_SLOW_BINS.length + 1) +
        bin(Math.abs(v[2]), MARKET_FORECAST_SLOW_BINS);
      const value = MARKET_FORECAST_3_EMA[cell];
      if (Number.isFinite(value)) direct = sign * value;
    }

    if (age >= DERIVED_WARMUP_MS && v[3] !== 0) {
      const sign = Math.sign(v[3]);
      const contrast = (v[0] - v[2]) * sign;
      const curvature = ((v[0] - v[1]) / ((15 - 7) / 60) -
        (v[2] - v[3]) / ((60 - 30) / 60)) * sign;
      if (Number.isFinite(contrast) && Number.isFinite(curvature)) {
        const cell = (bin(contrast, MARKET_FORECAST_ALIGNED_BINS) *
          (MARKET_FORECAST_CURVATURE_BINS.length + 1) +
          bin(curvature, MARKET_FORECAST_CURVATURE_BINS)) *
          (MARKET_FORECAST_SLOW_BINS.length + 1) +
          bin(Math.abs(v[3]), MARKET_FORECAST_SLOW_BINS);
        const value = MARKET_FORECAST_4_EMA[cell];
        if (Number.isFinite(value)) derived = sign * value;
      }
    }

    if (direct === null) return derived;
    if (derived === null) return direct;
    const cell = bin(direct, MARKET_FORECAST_PAIR_BINS) *
      (MARKET_FORECAST_PAIR_BINS.length + 1) +
      bin(derived, MARKET_FORECAST_PAIR_BINS);
    const combined = (direct + derived) / 2 +
      MARKET_FORECAST_COMBINED_CORRECTION[cell];
    return Number.isFinite(combined) ? combined : null;
  }
}

function csv(values: (string | number | null)[]): string {
  return values.map((value) => {
    if (value === null) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(',');
}

function* readTicks(db: DatabaseSync, marketId: number): Generator<Tick> {
  const query = db.prepare(`
    SELECT received_at AS t, price AS p FROM observations
    WHERE market_id = ? ORDER BY received_at
  `);
  for (const row of query.iterate(marketId)) yield row as Tick;
}

async function newestCache(): Promise<string> {
  if (CACHE_PATH) return resolve(CACHE_PATH);
  const filenames = (await readdir(CACHE_DIR)).filter((name) =>
    /^market-research-cache_endedAt-.*\.sqlite$/.test(name)).sort();
  if (!filenames.length) throw new Error('No completed SQLite caches');
  return resolve(CACHE_DIR, filenames[filenames.length - 1]);
}

class MarketSimulation {
  private readonly forecast = new Forecast();
  private readonly runners = COMBOS.map((): Runner => ({
    position: null, pending: null, equity: [0, 0, 0],
    peak: [0, 0, 0],
  }));
  private readonly ownStats = COMBOS.map(() =>
    [stats(), stats(), stats()]); // all, long, short
  private period: Period | null = null;
  private lastTick: Tick | null = null;
  private lastDecision = -Infinity;
  private validForecasts = 0;

  constructor(
    private readonly market: Market,
    private readonly splitAt: number,
    private readonly totals: Record<Period, Stats[][]>,
    private readonly marketCsv: string[],
  ) {}

  run(db: DatabaseSync): void {
    for (const tick of readTicks(db, this.market.id)) {
      const forecast = this.forecast.update(tick.t, tick.p);
      if (tick.t <= FROZEN_END) continue;
      const period: Period = tick.t < this.splitAt
        ? 'validation' : 'test';
      if (this.period !== period) {
        if (this.period && this.lastTick) this.finishPeriod();
        this.period = period;
        this.lastTick = null;
        this.lastDecision = -Infinity;
        this.validForecasts = 0;
      }
      const previous = this.lastTick;
      const gap = previous !== null &&
        tick.t - previous.t > MAX_TICK_GAP_MS;
      const decide = tick.t - this.lastDecision >= DECISION_INTERVAL_MS;
      if (decide) this.lastDecision = tick.t;
      if (forecast !== null) this.validForecasts++;

      for (let i = 0; i < COMBOS.length; i++) {
        const runner = this.runners[i];
        if (gap) {
          runner.pending = null;
          if (runner.position) this.close(i, tick, 'gap');
          continue;
        }
        if (runner.pending) {
          const pending = runner.pending;
          runner.pending = null;
          if (pending.action === 'enter') {
            if (tick.t - pending.at <= MAX_SIGNAL_TO_FILL_MS) {
              runner.position = {
                side: pending.side, enteredAt: tick.t,
                entryPrice: tick.p, mfe: 0, mae: 0,
              };
            }
          } else if (runner.position) {
            this.close(i, tick, 'signal');
          }
        }
        const position = runner.position;
        if (position) {
          const move = 1000 * position.side *
            Math.log(tick.p / position.entryPrice);
          position.mfe = Math.max(position.mfe, move);
          position.mae = Math.min(position.mae, move);
        }
        if (!decide || forecast === null || runner.pending) continue;
        if (position) {
          if (position.side * forecast <= COMBOS[i].exit) {
            runner.pending = {
              action: 'exit', side: position.side, at: tick.t,
            };
          }
        } else if (Math.abs(forecast) >= COMBOS[i].entry) {
          runner.pending = {
            action: 'enter', side: forecast > 0 ? 1 : -1,
            at: tick.t,
          };
        }
      }
      this.lastTick = tick;
    }
    if (this.period && this.lastTick) this.finishPeriod();
  }

  private close(i: number, tick: Tick, reason: CloseReason): void {
    const runner = this.runners[i];
    const position = runner.position;
    if (!position) return;
    const gross = 1000 * position.side *
      Math.log(tick.p / position.entryPrice);
    const net = gross - COST_PER_ROUNDTRIP;
    for (const index of [0, position.side === 1 ? 1 : 2]) {
      runner.equity[index] += net;
      runner.peak[index] = Math.max(
        runner.peak[index], runner.equity[index]);
      const drawdown = runner.peak[index] - runner.equity[index];
      const result = this.ownStats[i][index];
      result.trades++;
      result.wins += Number(net > 0);
      result.gross += gross;
      result.net += net;
      result.mfe += Math.max(position.mfe, gross);
      result.mae += Math.min(position.mae, gross);
      result.durationMs += tick.t - position.enteredAt;
      if (reason === 'signal') result.signalCloses++;
      if (reason === 'gap') result.gapCloses++;
      if (reason === 'end') result.endCloses++;
      result.maxMarketDrawdown = Math.max(
        result.maxMarketDrawdown, drawdown);
    }
    runner.position = null;
  }

  private finishPeriod(): void {
    if (!this.period || !this.lastTick) return;
    for (let i = 0; i < COMBOS.length; i++) {
      const runner = this.runners[i];
      if (runner.position) this.close(i, this.lastTick, 'end');
      runner.pending = null;
      runner.equity.fill(0);
      runner.peak.fill(0);
      for (let d = 0; d < 3; d++) {
        const result = this.ownStats[i][d];
        addStats(this.totals[this.period][i][d], result);
        if (result.trades) {
          this.marketCsv.push(csv([
            this.period, this.market.name, this.market.money,
            COMBOS[i].entry, COMBOS[i].exit,
            ['all', 'long', 'short'][d], ...statsValues(result),
          ]));
        }
        this.ownStats[i][d] = stats();
      }
    }
    console.log(`${this.market.name}: ${this.period}, ` +
      `forecast ticks=${this.validForecasts}`);
  }
}

function statsValues(s: Stats): number[] {
  const n = s.trades;
  return [
    n, s.wins, n ? s.wins / n : 0,
    s.gross, s.net, n ? s.net / n : 0,
    n ? s.durationMs / n / 1000 : 0,
    n ? s.mfe / n : 0, n ? s.mae / n : 0,
    s.signalCloses, s.gapCloses, s.endCloses,
    s.maxMarketDrawdown,
  ];
}

const STATS_HEADER = [
  'trades', 'wins', 'winRate', 'grossLogPermilleSum',
  'netLogPermilleSum', 'avgNetLogPermille',
  'avgDurationSeconds', 'avgMfePermille', 'avgMaePermille',
  'signalCloses', 'gapCloses', 'periodEndCloses',
  'worstSingleMarketDrawdownLogPermille',
];

async function main(): Promise<void> {
  const cache = await newestCache();
  const db = new DatabaseSync(cache, { readOnly: true });
  try {
    const schema = db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (schema.user_version !== 1) {
      throw new Error(`Expected SQLite cache schema v1, got ${schema.user_version}`);
    }
    const range = db.prepare(`
      SELECT MAX(received_at) AS last FROM observations
    `).get() as { last: number | null };
    if (range.last === null || range.last - FROZEN_END < MIN_NEW_DATA_MS) {
      throw new Error('Not enough data strictly after frozen table cutoff');
    }
    const splitAt = Math.floor(FROZEN_END +
      VALIDATION_FRACTION * (range.last - FROZEN_END));
    const markets = (db.prepare(`
      SELECT id, name, money FROM markets
      WHERE type = 'spot' AND EXISTS (
        SELECT 1 FROM observations WHERE market_id = markets.id
      ) ORDER BY name
    `).all() as Market[]).filter((market) =>
      QUOTE_CURRENCIES.includes(market.money) &&
      (!MARKET_NAMES.length || MARKET_NAMES.includes(market.name)));
    if (!markets.length) throw new Error('No eligible markets');
    const totals: Record<Period, Stats[][]> = {
      validation: COMBOS.map(() => [stats(), stats(), stats()]),
      test: COMBOS.map(() => [stats(), stats(), stats()]),
    };
    const marketCsv = [csv([
      'period', 'market', 'quote', 'entryThreshold',
      'exitThreshold', 'direction', ...STATS_HEADER,
    ])];
    const output = await mkdtemp(resolve(OUTPUT_DIR, 'run-'));
    console.log(`Cache: ${cache}`);
    console.log(`Markets: ${markets.length}; combos: ${COMBOS.length}`);
    console.log(`Frozen through: ${FROZEN_TABLE_END_ISO}`);
    console.log(`Validation: (${FROZEN_TABLE_END_ISO}, ` +
      `${new Date(splitAt).toISOString()})`);
    console.log(`Test: [${new Date(splitAt).toISOString()}, ` +
      `${new Date(range.last).toISOString()}]`);
    console.log(`Round-trip log cost: ${COST_PER_ROUNDTRIP.toFixed(6)}‰`);

    for (let i = 0; i < markets.length; i++) {
      new MarketSimulation(markets[i], splitAt, totals, marketCsv).run(db);
      if ((i + 1) % 25 === 0) {
        console.log(`Processed ${i + 1}/${markets.length} markets`);
      }
    }
    const summary = [csv([
      'period', 'entryThreshold', 'exitThreshold', 'direction',
      ...STATS_HEADER,
    ])];
    for (const period of ['validation', 'test'] as const) {
      for (let i = 0; i < COMBOS.length; i++) {
        for (let d = 0; d < 3; d++) {
          summary.push(csv([
            period, COMBOS[i].entry, COMBOS[i].exit,
            ['all', 'long', 'short'][d],
            ...statsValues(totals[period][i][d]),
          ]));
        }
      }
    }
    await writeFile(resolve(output, 'summary.csv'),
      summary.join('\n') + '\n');
    await writeFile(resolve(output, 'by-market.csv'),
      marketCsv.join('\n') + '\n');
    await writeFile(resolve(output, 'run.json'), JSON.stringify({
      cache: basename(cache), tableFrozenThrough: FROZEN_TABLE_END_ISO,
      splitAt: new Date(splitAt).toISOString(),
      lastTick: new Date(range.last).toISOString(),
      markets: markets.length, quoteCurrencies: QUOTE_CURRENCIES,
      combos: COMBOS, feePerSidePermille: FEE_PER_SIDE_PERMILLE,
      slippagePerSidePermille: SLIPPAGE_PER_SIDE_PERMILLE,
      costPerRoundTripLogPermille: COST_PER_ROUNDTRIP,
      maxSignalToFillMs: MAX_SIGNAL_TO_FILL_MS,
      maxTickGapMs: MAX_TICK_GAP_MS,
      decisionIntervalMs: DECISION_INTERVAL_MS,
      priceModel: 'next tick, no order book, log-return P&L',
      shortModel: 'idealized symmetric short; no borrow/funding costs',
      splitPolicy: 'close residual positions at last tick of each period',
    }, null, 2) + '\n');
    console.log(`Finished: ${output}`);
  } finally {
    db.close();
  }
}

void mkdir(OUTPUT_DIR, { recursive: true })
  .then(main)
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
