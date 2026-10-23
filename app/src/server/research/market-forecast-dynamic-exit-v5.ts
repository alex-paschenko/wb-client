// app/src/server/research/market-forecast-dynamic-exit-v5.ts
// Run from app: node --import tsx src/server/research/market-forecast-dynamic-exit-v5.ts
// Frozen v6 combined forecast, delayed long entry and dynamic exit.
// Research only: trade prices are last trades, not executable book quotes.

import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
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

const CACHE_PATH: string | null = null;
const CACHE_DIR = resolve('research-output/market-research-cache');
const OUTPUT_DIR = resolve('research-output/market-forecast-dynamic-exit-v5');
const FROZEN_TABLE_END_ISO = '2026-10-02T01:40:49.395Z';
const VALIDATION_FRACTION = 0.5;
const QUOTE_CURRENCIES = ['USD', 'USDT'];
const MARKET_NAMES: string[] = []; // Empty: all suitable spot markets.

const SIGNALS = [
  { name: 'common', value: 3.4826581683543187 },
  { name: 'rare', value: 3.544129753241629 },
] as const;
const SIGNAL_TOLERANCE = 1e-9;
const ENTRY_GROUPS = ['common', 'rare', 'both'] as const;
const EXIT_THRESHOLDS = [-2, -1.5, -1, -0.75, -0.5, 0];
const DELAYS_MS = [0, 1000, 2000, 3000, 5000, 10_000];

// A delayed action is filled on the first available tick after its due
// time. Missing ENTRY prices are skipped; EXIT prices are never discarded.
const MAX_ENTRY_LATENESS_MS = 10_000;
const MAX_TICK_GAP_MS = 60_000;
const DECISION_INTERVAL_MS = 1000;
const FEE_PER_SIDE_PERMILLE = 1;
const SLIPPAGE_PER_SIDE_PERMILLE = 0;

// Journal only a useful subset; all scenarios are included in CSV summaries.
const SAVE_TRADES = true;
const JOURNAL_DELAY_MS = [0, 2000, 5000, 10_000];
const JOURNAL_EXITS = [-2, -1, 0];
const PROGRESS_INTERVAL_MS = 10_000;
const PROGRESS_TICK_INTERVAL = 4096;

const TAUS_MS = [7000, 15_000, 30_000, 60_000] as const;
const DIRECT_WARMUP_MS = 150_000;
const DERIVED_WARMUP_MS = 300_000;
const FROZEN_END = Date.parse(FROZEN_TABLE_END_ISO);
const PERIODS = ['validation', 'test'] as const;
const COST_PER_ROUNDTRIP = (() => {
  const f = FEE_PER_SIDE_PERMILLE / 1000;
  const s = SLIPPAGE_PER_SIDE_PERMILLE / 1000;
  if (f < 0 || f >= 1 || s < 0 || s >= 1) {
    throw new Error('Invalid transaction costs');
  }
  // Keep the same log-cost convention as v3/v4 for comparisons.
  return 1000 * (Math.log1p(f) - Math.log1p(-f) +
    Math.log1p(s) - Math.log1p(-s));
})();
if (!Number.isFinite(FROZEN_END)) throw new Error('Invalid table cutoff');

type Period = typeof PERIODS[number];
type EntryGroup = typeof ENTRY_GROUPS[number];
type Tick = { t: number; p: number };
type Market = { id: number; name: string; money: string };
type Scenario = {
  id: number;
  group: EntryGroup;
  exit: number;
  entryDelayMs: number;
  exitDelayMs: number;
  journal: boolean;
};
type Pending = { at: number; forecast: number; dueAt: number };
type Position = {
  signalAt: number;
  signalForecast: number;
  enteredAt: number;
  entryPrice: number;
  entryDelayMs: number;
  mfe: number;
  mae: number;
};
type CloseReason = 'signal' | 'gap' | 'boundary';
type Stats = {
  trades: number;
  wins: number;
  gross: number;
  net: number;
  durationMs: number;
  mfe: number;
  mae: number;
  entryDelayMs: number;
  exitDelayMs: number;
  missedEntries: number;
  lateExits: number;
  signalCloses: number;
  gapCloses: number;
  boundaryCloses: number;
  maxMarketDrawdown: number;
};
type DurationStats = {
  trades: number;
  wins: number;
  net: number;
  gross: number;
};
type Runner = {
  scenario: Scenario;
  entry: Pending | null;
  exit: Pending | null;
  position: Position | null;
  stats: Stats;
  equity: number;
  peak: number;
};
type Contribution = { market: string; net: number; trades: number };

const SCENARIOS: Scenario[] = [];
for (const group of ENTRY_GROUPS) {
  for (const exit of EXIT_THRESHOLDS) {
    for (const entryDelayMs of DELAYS_MS) {
      for (const exitDelayMs of DELAYS_MS) {
        SCENARIOS.push({
          id: SCENARIOS.length, group, exit,
          entryDelayMs, exitDelayMs,
          journal: SAVE_TRADES && JOURNAL_EXITS.includes(exit) &&
            JOURNAL_DELAY_MS.includes(entryDelayMs) &&
            JOURNAL_DELAY_MS.includes(exitDelayMs),
        });
      }
    }
  }
}

const DURATION_BOUNDS_MS = [
  15_000, 30_000, 60_000, 120_000,
  300_000, 600_000, 1_800_000,
];
const STATS_HEADER = [
  'trades', 'wins', 'winRate', 'grossLogPermilleSum',
  'netLogPermilleSum', 'avgNetLogPermille',
  'avgDurationSeconds', 'avgMfePermille', 'avgMaePermille',
  'avgActualEntryDelayMs', 'avgActualExitDelayMs',
  'missedEntries', 'lateExits', 'signalCloses',
  'gapCloses', 'boundaryCloses', 'worstMarketDrawdownLogPermille',
];

function zeroStats(): Stats {
  return {
    trades: 0, wins: 0, gross: 0, net: 0, durationMs: 0,
    mfe: 0, mae: 0, entryDelayMs: 0, exitDelayMs: 0,
    missedEntries: 0, lateExits: 0, signalCloses: 0,
    gapCloses: 0, boundaryCloses: 0, maxMarketDrawdown: 0,
  };
}

function addStats(to: Stats, from: Stats): void {
  for (const key of [
    'trades', 'wins', 'gross', 'net', 'durationMs', 'mfe', 'mae',
    'entryDelayMs', 'exitDelayMs', 'missedEntries', 'lateExits',
    'signalCloses', 'gapCloses', 'boundaryCloses',
  ] as const) to[key] += from[key];
  to.maxMarketDrawdown = Math.max(
    to.maxMarketDrawdown, from.maxMarketDrawdown);
}

function statsColumns(s: Stats): number[] {
  const n = s.trades;
  return [
    n, s.wins, n ? s.wins / n : NaN, s.gross, s.net,
    n ? s.net / n : NaN, n ? s.durationMs / n / 1000 : NaN,
    n ? s.mfe / n : NaN, n ? s.mae / n : NaN,
    n ? s.entryDelayMs / n : NaN,
    n ? s.exitDelayMs / n : NaN,
    s.missedEntries, s.lateExits, s.signalCloses,
    s.gapCloses, s.boundaryCloses, s.maxMarketDrawdown,
  ];
}

function csv(values: (string | number | null)[]): string {
  return values.map((value) => {
    if (value === null || typeof value === 'number' &&
      !Number.isFinite(value)) return '';
    const s = String(value);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  }).join(',');
}

class CsvSink {
  private readonly fd: number;
  private readonly lines: string[] = [];
  private bytes = 0;

  constructor(path: string, header: string[]) {
    this.fd = openSync(path, 'w');
    this.add(header);
  }

  add(values: (string | number | null)[]): void {
    const line = csv(values) + '\n';
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line);
    if (this.bytes >= 256 * 1024) this.flush();
  }

  flush(): void {
    if (!this.lines.length) return;
    const buffer = Buffer.from(this.lines.join(''));
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(this.fd, buffer, offset,
        buffer.length - offset);
    }
    this.lines.length = 0;
    this.bytes = 0;
  }

  close(): void {
    try { this.flush(); } finally { closeSync(this.fd); }
  }
}

function bin(value: number, bounds: readonly number[]): number {
  for (let i = 0; i < bounds.length; i++) {
    if (value < bounds[i]) return i;
  }
  return bounds.length;
}

// Reproduce frozen v6 MarketForecastIndicator combined value.
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
      if (t <= this.previous) throw new Error('Non-increasing ticks');
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
    const pairCell = bin(direct, MARKET_FORECAST_PAIR_BINS) *
      (MARKET_FORECAST_PAIR_BINS.length + 1) +
      bin(derived, MARKET_FORECAST_PAIR_BINS);
    const combined = (direct + derived) / 2 +
      MARKET_FORECAST_COMBINED_CORRECTION[pairCell];
    return Number.isFinite(combined) ? combined : null;
  }
}

function* readTicks(db: DatabaseSync, marketId: number): Generator<Tick> {
  const statement = db.prepare(`
    SELECT received_at AS t, price AS p FROM observations
    WHERE market_id = ? ORDER BY received_at
  `);
  for (const row of statement.iterate(marketId)) yield row as Tick;
}

async function newestCache(): Promise<string> {
  if (CACHE_PATH) return resolve(CACHE_PATH);
  const names = (await readdir(CACHE_DIR)).filter((name) =>
    /^market-research-cache_endedAt-.*\.sqlite$/.test(name)).sort();
  if (!names.length) throw new Error('No completed SQLite cache');
  return resolve(CACHE_DIR, names[names.length - 1]);
}

function signalGroup(forecast: number | null): EntryGroup | null {
  if (forecast === null) return null;
  for (const signal of SIGNALS) {
    if (Math.abs(forecast - signal.value) <= SIGNAL_TOLERANCE) {
      return signal.name;
    }
  }
  return null;
}

class Results {
  readonly totals: Record<Period, Stats[]> = {
    validation: SCENARIOS.map(() => zeroStats()),
    test: SCENARIOS.map(() => zeroStats()),
  };
  readonly contributions: Record<Period, Contribution[][]> = {
    validation: SCENARIOS.map(() => []),
    test: SCENARIOS.map(() => []),
  };
  readonly durations: Record<Period, DurationStats[][]> = {
    validation: SCENARIOS.map(() => this.durationBuckets()),
    test: SCENARIOS.map(() => this.durationBuckets()),
  };
  readonly byMarket: string[] = [csv([
    'period', 'market', 'group', 'exitThreshold',
    'entryDelaySeconds', 'exitDelaySeconds', ...STATS_HEADER,
  ])];

  private durationBuckets(): DurationStats[] {
    return Array.from({ length: DURATION_BOUNDS_MS.length + 1 }, () => ({
      trades: 0, wins: 0, net: 0, gross: 0,
    }));
  }

  addTrade(period: Period, id: number, duration: number,
    gross: number, net: number): void {
    const bucket = this.durations[period][id][
      bin(duration, DURATION_BOUNDS_MS)];
    bucket.trades++;
    bucket.wins += Number(net > 0);
    bucket.net += net;
    bucket.gross += gross;
  }

  finishMarket(period: Period, market: string, runners: Runner[]): void {
    for (const runner of runners) {
      const s = runner.stats;
      addStats(this.totals[period][runner.scenario.id], s);
      if (s.trades === 0 && s.missedEntries === 0) continue;
      const sc = runner.scenario;
      this.byMarket.push(csv([
        period, market, sc.group, sc.exit,
        sc.entryDelayMs / 1000, sc.exitDelayMs / 1000,
        ...statsColumns(s),
      ]));
      if (s.trades) this.contributions[period][sc.id].push({
        market, net: s.net, trades: s.trades,
      });
    }
  }

  files(): Record<string, string> {
    const head = [
      'period', 'group', 'exitThreshold',
      'entryDelaySeconds', 'exitDelaySeconds',
    ];
    const summary = [csv([...head, ...STATS_HEADER])];
    const duration = [csv([
      ...head, 'durationFromSeconds', 'durationToSeconds',
      'trades', 'wins', 'netLogPermilleSum',
      'meanNetLogPermille', 'grossLogPermilleSum',
    ])];
    const concentration = [csv([
      ...head, 'marketsWithTrades', 'profitableMarkets',
      'netLogPermilleSum', 'netExcludingTop1',
      'netExcludingTop2', 'netExcludingTop5',
      'top1Market', 'top1Net', 'top2Market', 'top2Net',
    ])];
    for (const period of PERIODS) {
      for (const sc of SCENARIOS) {
        const prefix = [period, sc.group, sc.exit,
          sc.entryDelayMs / 1000, sc.exitDelayMs / 1000];
        const s = this.totals[period][sc.id];
        summary.push(csv([...prefix, ...statsColumns(s)]));
        this.durations[period][sc.id].forEach((b, i) => {
          duration.push(csv([
            ...prefix,
            i ? DURATION_BOUNDS_MS[i - 1] / 1000 : 0,
            i < DURATION_BOUNDS_MS.length ?
              DURATION_BOUNDS_MS[i] / 1000 : null,
            b.trades, b.wins, b.net,
            b.trades ? b.net / b.trades : null, b.gross,
          ]));
        });
        const markets = [...this.contributions[period][sc.id]]
          .sort((a, b) => b.net - a.net);
        const top = (n: number) => markets.slice(0, n).reduce(
          (sum, m) => sum + m.net, 0);
        concentration.push(csv([
          ...prefix, markets.length,
          markets.filter((m) => m.net > 0).length,
          s.net, s.net - top(1), s.net - top(2), s.net - top(5),
          markets[0]?.market ?? '', markets[0]?.net ?? null,
          markets[1]?.market ?? '', markets[1]?.net ?? null,
        ]));
      }
    }
    return {
      'summary.csv': summary.join('\n') + '\n',
      'by-market.csv': this.byMarket.join('\n') + '\n',
      'duration.csv': duration.join('\n') + '\n',
      'concentration.csv': concentration.join('\n') + '\n',
    };
  }
}

class MarketSimulation {
  private readonly predictor = new Forecast();
  private readonly runners = SCENARIOS.map((scenario): Runner => ({
    scenario, entry: null, exit: null, position: null,
    stats: zeroStats(), equity: 0, peak: 0,
  }));
  private readonly active = new Set<Runner>();
  private readonly common = SCENARIOS.filter((s) =>
    s.group === 'common' || s.group === 'both');
  private readonly rare = SCENARIOS.filter((s) =>
    s.group === 'rare' || s.group === 'both');
  private period: Period | null = null;
  private lastTick: Tick | null = null;
  private lastDecision = -Infinity;
  private ticks = 0;
  private signals = 0;

  constructor(
    private readonly market: Market,
    private readonly splitAt: number,
    private readonly results: Results,
    private readonly journal: CsvSink | null,
  ) {}

  run(db: DatabaseSync): void {
    let lastProgress = Date.now();
    console.log(`[market] ${this.market.name}: started`);
    for (const tick of readTicks(db, this.market.id)) {
      this.ticks++;
      if (this.ticks % PROGRESS_TICK_INTERVAL === 0 &&
        Date.now() - lastProgress >= PROGRESS_INTERVAL_MS) {
        console.log(`[market] ${this.market.name}: ` +
          `${this.ticks.toLocaleString()} ticks; ` +
          `${new Date(tick.t).toISOString()}; ` +
          `active=${this.active.size}; signals=${this.signals}`);
        lastProgress = Date.now();
      }
      const forecast = this.predictor.update(tick.t, tick.p);
      if (tick.t <= FROZEN_END) continue;
      const period: Period = tick.t < this.splitAt ?
        'validation' : 'test';
      if (period !== this.period) {
        this.finishPeriod();
        this.period = period;
        this.lastTick = null;
        this.lastDecision = -Infinity;
      }
      const gap = this.lastTick !== null &&
        tick.t - this.lastTick.t > MAX_TICK_GAP_MS;
      const decision = tick.t - this.lastDecision >=
        DECISION_INTERVAL_MS;
      if (decision) this.lastDecision = tick.t;

      if (gap) {
        for (const runner of this.active) {
          if (runner.position) this.close(runner, tick, 'gap');
          else this.release(runner);
        }
      } else {
        // Work only with outstanding requests and open positions.
        // A newly created request is never filled on its signal tick.
        for (const runner of this.active) {
          this.advance(runner, tick, decision ? forecast : null);
        }
        if (decision) {
          const group = signalGroup(forecast);
          if (group !== null) {
            this.signals++;
            const scenarios = group === 'common' ?
              this.common : this.rare;
            for (const sc of scenarios) {
              const runner = this.runners[sc.id];
              if (runner.entry || runner.position) continue;
              runner.entry = {
                at: tick.t, forecast: forecast!,
                dueAt: tick.t + sc.entryDelayMs,
              };
              this.active.add(runner);
            }
          }
        }
      }
      this.lastTick = tick;
    }
    this.finishPeriod();
    console.log(`[market] ${this.market.name}: done, ` +
      `${this.ticks.toLocaleString()} ticks, ` +
      `${this.signals.toLocaleString()} target signals`);
  }

  private advance(
    runner: Runner, tick: Tick, forecast: number | null,
  ): void {
    if (runner.entry && tick.t > runner.entry.at &&
      tick.t >= runner.entry.dueAt) {
      const entry = runner.entry;
      runner.entry = null;
      if (tick.t - entry.dueAt > MAX_ENTRY_LATENESS_MS) {
        runner.stats.missedEntries++;
        this.release(runner);
        return;
      }
      runner.position = {
        signalAt: entry.at, signalForecast: entry.forecast,
        enteredAt: tick.t, entryPrice: tick.p,
        entryDelayMs: tick.t - entry.at,
        mfe: 0, mae: 0,
      };
    }
    if (runner.exit && tick.t > runner.exit.at &&
      tick.t >= runner.exit.dueAt) {
      this.close(runner, tick, 'signal', runner.exit);
      return;
    }
    const pos = runner.position;
    if (!pos) return;
    const move = 1000 * Math.log(tick.p / pos.entryPrice);
    pos.mfe = Math.max(pos.mfe, move);
    pos.mae = Math.min(pos.mae, move);
    if (!runner.exit && forecast !== null &&
      forecast <= runner.scenario.exit) {
      runner.exit = {
        at: tick.t, forecast,
        dueAt: tick.t + runner.scenario.exitDelayMs,
      };
    }
  }

  private close(
    runner: Runner, tick: Tick, reason: CloseReason,
    exit: Pending | null = null,
  ): void {
    const pos = runner.position;
    if (!pos || this.period === null) return;
    const s = runner.stats;
    const gross = 1000 * Math.log(tick.p / pos.entryPrice);
    const net = gross - COST_PER_ROUNDTRIP;
    const duration = tick.t - pos.enteredAt;
    s.trades++;
    s.wins += Number(net > 0);
    s.gross += gross;
    s.net += net;
    s.durationMs += duration;
    s.mfe += Math.max(pos.mfe, gross);
    s.mae += Math.min(pos.mae, gross);
    s.entryDelayMs += pos.entryDelayMs;
    s.exitDelayMs += exit ? tick.t - exit.at : 0;
    if (reason === 'signal') {
      s.signalCloses++;
      if (exit && tick.t - exit.dueAt > MAX_ENTRY_LATENESS_MS) {
        s.lateExits++;
      }
    } else if (reason === 'gap') s.gapCloses++;
    else s.boundaryCloses++;
    runner.equity += net;
    runner.peak = Math.max(runner.peak, runner.equity);
    s.maxMarketDrawdown = Math.max(
      s.maxMarketDrawdown, runner.peak - runner.equity);
    this.results.addTrade(this.period, runner.scenario.id,
      duration, gross, net);
    if (this.journal && runner.scenario.journal) {
      const sc = runner.scenario;
      this.journal.add([
        this.period, this.market.name, sc.group, sc.exit,
        sc.entryDelayMs / 1000, sc.exitDelayMs / 1000,
        pos.signalAt, pos.signalForecast, pos.enteredAt,
        pos.entryPrice, pos.entryDelayMs,
        exit?.at ?? null, exit?.forecast ?? null,
        tick.t, tick.p, exit ? tick.t - exit.at : null,
        duration / 1000, gross, net, pos.mfe, pos.mae, reason,
      ]);
    }
    this.release(runner);
  }

  private release(runner: Runner): void {
    runner.entry = null;
    runner.exit = null;
    runner.position = null;
    this.active.delete(runner);
  }

  private finishPeriod(): void {
    if (this.period === null || this.lastTick === null) return;
    for (const runner of this.active) {
      if (runner.position) this.close(runner, this.lastTick, 'boundary');
      else this.release(runner);
    }
    this.results.finishMarket(
      this.period, this.market.name, this.runners);
    for (const runner of this.runners) {
      runner.stats = zeroStats();
      runner.equity = 0;
      runner.peak = 0;
    }
  }
}

async function main(): Promise<void> {
  console.log('[startup] Selecting completed SQLite cache...');
  const cache = await newestCache();
  console.log(`[startup] Opening ${cache}`);
  const db = new DatabaseSync(cache, { readOnly: true });
  let journal: CsvSink | null = null;
  try {
    const version = db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (version.user_version !== 1) {
      throw new Error(`Expected cache schema v1; got ${version.user_version}`);
    }
    console.log('[startup] Reading market_cache_stats (no full scan)...');
    const range = db.prepare(`
      SELECT MAX(last_received_at) AS last FROM market_cache_stats
    `).get() as { last: number | null };
    if (range.last === null || range.last <= FROZEN_END) {
      throw new Error('No observations after frozen table cutoff');
    }
    const splitAt = Math.floor(FROZEN_END +
      (range.last - FROZEN_END) * VALIDATION_FRACTION);
    console.log('[startup] Selecting USD/USDT spot markets...');
    const markets = (db.prepare(`
      SELECT id, name, money FROM markets
      WHERE type = 'spot' AND EXISTS (
        SELECT 1 FROM observations WHERE market_id = markets.id
      ) ORDER BY name
    `).all() as Market[]).filter((m) =>
      QUOTE_CURRENCIES.includes(m.money) &&
      (!MARKET_NAMES.length || MARKET_NAMES.includes(m.name)));
    if (!markets.length) throw new Error('No eligible markets');
    console.log('[startup] Creating result directory...');
    await mkdir(OUTPUT_DIR, { recursive: true });
    const output = await mkdtemp(resolve(OUTPUT_DIR, 'run-'));
    if (SAVE_TRADES) {
      journal = new CsvSink(resolve(output, 'trades-sample.csv'), [
        'period', 'market', 'group', 'exitThreshold',
        'entryDelaySeconds', 'exitDelaySeconds',
        'entrySignalAt', 'entrySignalForecast',
        'enteredAt', 'entryPrice', 'actualEntryDelayMs',
        'exitSignalAt', 'exitSignalForecast',
        'exitedAt', 'exitPrice', 'actualExitDelayMs',
        'durationSeconds', 'grossLogPermille', 'netLogPermille',
        'mfePermille', 'maePermille', 'reason',
      ]);
    }
    const results = new Results();
    console.log(`Markets: ${markets.length}; ` +
      `scenarios: ${SCENARIOS.length}; output: ${output}`);
    console.log(`Validation: ${FROZEN_TABLE_END_ISO} to ` +
      new Date(splitAt).toISOString());
    console.log(`Test: ${new Date(splitAt).toISOString()} to ` +
      new Date(range.last).toISOString());
    console.log(`Entry and exit delays: ${DELAYS_MS.map((d) => d / 1000)}`);
    console.log(`Cost per round trip: ${COST_PER_ROUNDTRIP.toFixed(6)}‰`);
    console.log('[start] Processing cached observations...');
    for (let i = 0; i < markets.length; i++) {
      new MarketSimulation(markets[i], splitAt, results, journal).run(db);
      console.log(`[progress] ${i + 1}/${markets.length} markets ` +
        `(${(100 * (i + 1) / markets.length).toFixed(1)}%)`);
    }
    console.log('[save] Writing reports...');
    for (const [name, content] of Object.entries(results.files())) {
      await writeFile(resolve(output, name), content);
    }
    journal?.close();
    journal = null;
    await writeFile(resolve(output, 'run.json'), JSON.stringify({
      cache: basename(cache), frozenTableEnd: FROZEN_TABLE_END_ISO,
      splitAt: new Date(splitAt).toISOString(),
      lastTick: new Date(range.last).toISOString(),
      markets: markets.length, quoteCurrencies: QUOTE_CURRENCIES,
      entryGroups: ENTRY_GROUPS, targetSignals: SIGNALS,
      exits: EXIT_THRESHOLDS, delaysMs: DELAYS_MS,
      scenarios: SCENARIOS.length,
      feePerSidePermille: FEE_PER_SIDE_PERMILLE,
      slippagePerSidePermille: SLIPPAGE_PER_SIDE_PERMILLE,
      costPerRoundTripLogPermille: COST_PER_ROUNDTRIP,
      maxEntryLatenessMs: MAX_ENTRY_LATENESS_MS,
      maxTickGapMs: MAX_TICK_GAP_MS,
      decisionIntervalMs: DECISION_INTERVAL_MS,
      tradeJournalSubset: SAVE_TRADES ? {
        delayMs: JOURNAL_DELAY_MS, exits: JOURNAL_EXITS,
      } : null,
      priceModel: 'first tick strictly after signal and >= delay',
      exitFillPolicy: 'late exits still fill at next available tick',
      signalPolicy: 'only two exact positive combined table values',
      tradePolicy: 'one long per market per scenario; dynamic exit',
      splitPolicy: 'boundary closes at last available tick in period',
      caveat: 'Research only: last-trade fills, no spread or order book',
    }, null, 2) + '\n');
    console.log(`Finished: ${output}`);
  } finally {
    try { journal?.close(); } finally { db.close(); }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
