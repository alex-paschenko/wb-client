
// app/src/server/research/market-forecast-execution-delay-v4.ts
// Run from app: node --import tsx src/server/research/market-forecast-execution-delay-v4.ts
// Frozen v6 predictor, delayed entries, fixed t+60s exit (diagnostic only).
// This script does not retrain tables or rerun v3 trading simulations.

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
const OUTPUT_DIR = resolve('research-output/market-forecast-execution-delay-v4');
const FROZEN_TABLE_END_ISO = '2026-10-02T01:40:49.395Z';
const VALIDATION_FRACTION = 0.5;
const QUOTE_CURRENCIES = ['USD', 'USDT'];
const MARKET_NAMES: string[] = []; // Empty means all matching spot markets.

const TARGET_SIGNALS = [
  { name: '3.482658', value: 3.4826581683543187 },
  { name: '3.544130', value: 3.544129753241629 },
] as const;
const TARGET_TOLERANCE = 1e-9;

// Delay 0 means the first STRICTLY FOLLOWING tick, not the signal tick.
const ENTRY_DELAYS_MS = [0, 1000, 2000, 3000, 5000, 10_000] as const;
const TARGET_HORIZON_MS = 60_000; // Fixed at t_signal + 60s.
const MAX_PRICE_LATENESS_MS = 10_000;
const DECISION_INTERVAL_MS = 1000;
const INDEPENDENT_SAMPLE_SPACING_MS = 60_000;
const FEE_PER_SIDE_PERMILLE = 1;
const SLIPPAGE_PER_SIDE_PERMILLE = 0;
const SAVE_SIGNAL_SAMPLES = true;
const PROGRESS_INTERVAL_MS = 10_000;
const PROGRESS_TICKS_INTERVAL = 4096;

// Frozen feature buckets: descriptive only, NOT trained on validation/test.
const FEATURE_BUCKETS = {
  curvature: [-200, -100, -50, -20, 0, 20, 50, 100, 200, 500],
  speedRatio: [0, 1, 2, 3, 4, 5, 7, 10],
  absV7: [10, 20, 30, 50, 100, 200, 500],
  contrast: [0, 5, 10, 20, 30, 50, 100, 200],
} as const;

const TAUS_MS = [7000, 15_000, 30_000, 60_000] as const;
const DIRECT_WARMUP_MS = 150_000;
const DERIVED_WARMUP_MS = 300_000;
const FROZEN_END = Date.parse(FROZEN_TABLE_END_ISO);
const PERIODS = ['validation', 'test'] as const;
const COST_PER_ROUNDTRIP = (() => {
  const fee = FEE_PER_SIDE_PERMILLE / 1000;
  const slip = SLIPPAGE_PER_SIDE_PERMILLE / 1000;
  if (fee < 0 || fee >= 1 || slip < 0 || slip >= 1) {
    throw new Error('Invalid costs');
  }
  return 1000 * (Math.log1p(fee) - Math.log1p(-fee) +
    Math.log1p(slip) - Math.log1p(-slip));
})();

if (!Number.isFinite(FROZEN_END)) {
  throw new Error('Invalid FROZEN_TABLE_END_ISO');
}

type Period = typeof PERIODS[number];
type Market = { id: number; name: string; money: string };
type Tick = { t: number; p: number };
type TargetSignal = typeof TARGET_SIGNALS[number];
type FeatureName = keyof typeof FEATURE_BUCKETS;
type ForecastSample = {
  value: number | null;
  source: '3ema' | '4ema' | 'combined' | null;
  direct: number | null;
  derived: number | null;
  directCell: number;
  derivedCell: number;
  pairCell: number;
  speeds: number[];
  contrast: number | null;
  curvature: number | null;
};
type Features = {
  curvature: number;
  speedRatio: number;
  absV7: number;
  contrast: number;
};
type Fill = { price: number; t: number } | null;
type Signal = {
  period: Period;
  market: string;
  group: string;
  t: number;
  price: number;
  spaced: boolean;
  forecast: ForecastSample;
  features: Features;
  fills: Fill[];
  target: Fill;
  unresolved: number;
};
type Queue = { records: Signal[]; head: number };
type Aggregate = {
  key: string[];
  signals: number;
  spacedSignals: number;
  valid: number;
  spacedValid: number;
  missingFill: number;
  missingTarget: number;
  early: number;
  remaining: number;
  net: number;
  actualDelayMs: number;
  wins: number;
  spacedEarly: number;
  spacedRemaining: number;
  spacedNet: number;
  spacedWins: number;
  matchedValid: number;
  matchedRemaining: number;
  matchedNet: number;
  matchedSpacedValid: number;
  matchedSpacedNet: number;
};

function bin(value: number, bounds: readonly number[]): number {
  for (let i = 0; i < bounds.length; i++) {
    if (value < bounds[i]) return i;
  }
  return bounds.length;
}

function csv(values: (string | number | boolean | null)[]): string {
  return values.map((value) => {
    if (value === null || typeof value === 'number' &&
      !Number.isFinite(value)) return '';
    const text = String(value);
    return /[",\n]/.test(text) ?
      `"${text.replaceAll('"', '""')}"` : text;
  }).join(',');
}

class CsvSink {
  private readonly fd: number;
  private lines: string[] = [];
  private bytes = 0;

  constructor(path: string, header: string[]) {
    this.fd = openSync(path, 'w');
    this.add(header);
  }

  add(values: (string | number | boolean | null)[]): void {
    const line = csv(values) + '\n';
    this.lines.push(line);
    this.bytes += line.length;
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
    this.lines = [];
    this.bytes = 0;
  }

  close(): void {
    try { this.flush(); } finally { closeSync(this.fd); }
  }
}

// Identical recurrence and table indexing to the v3 Forecast class.
class Forecast {
  private readonly emas = new Float64Array(TAUS_MS.length);
  private first = NaN;
  private previous = NaN;

  update(t: number, price: number): ForecastSample {
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
    let directCell = -1;
    let derivedCell = -1;
    let contrast: number | null = null;
    let curvature: number | null = null;

    if (age >= DIRECT_WARMUP_MS && v[2] !== 0) {
      const sign = Math.sign(v[2]);
      directCell = (bin(v[0] * sign, MARKET_FORECAST_ALIGNED_BINS) *
        (MARKET_FORECAST_ALIGNED_BINS.length + 1) +
        bin(v[1] * sign, MARKET_FORECAST_ALIGNED_BINS)) *
        (MARKET_FORECAST_SLOW_BINS.length + 1) +
        bin(Math.abs(v[2]), MARKET_FORECAST_SLOW_BINS);
      const value = MARKET_FORECAST_3_EMA[directCell];
      if (Number.isFinite(value)) direct = sign * value;
    }
    if (age >= DERIVED_WARMUP_MS && v[3] !== 0) {
      const sign = Math.sign(v[3]);
      contrast = (v[0] - v[2]) * sign;
      curvature = ((v[0] - v[1]) / ((15 - 7) / 60) -
        (v[2] - v[3]) / ((60 - 30) / 60)) * sign;
      if (Number.isFinite(contrast) && Number.isFinite(curvature)) {
        derivedCell = (bin(contrast, MARKET_FORECAST_ALIGNED_BINS) *
          (MARKET_FORECAST_CURVATURE_BINS.length + 1) +
          bin(curvature, MARKET_FORECAST_CURVATURE_BINS)) *
          (MARKET_FORECAST_SLOW_BINS.length + 1) +
          bin(Math.abs(v[3]), MARKET_FORECAST_SLOW_BINS);
        const value = MARKET_FORECAST_4_EMA[derivedCell];
        if (Number.isFinite(value)) derived = sign * value;
      }
    }
    let value: number | null = direct ?? derived;
    let source: ForecastSample['source'] = direct === null ?
      derived === null ? null : '4ema' : '3ema';
    let pairCell = -1;
    if (direct !== null && derived !== null) {
      pairCell = bin(direct, MARKET_FORECAST_PAIR_BINS) *
        (MARKET_FORECAST_PAIR_BINS.length + 1) +
        bin(derived, MARKET_FORECAST_PAIR_BINS);
      value = (direct + derived) / 2 +
        MARKET_FORECAST_COMBINED_CORRECTION[pairCell];
      source = Number.isFinite(value) ? 'combined' : null;
      if (source === null) value = null;
    }
    return {
      value, source, direct, derived, directCell, derivedCell,
      pairCell, speeds: v, contrast, curvature,
    };
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
  const files = (await readdir(CACHE_DIR)).filter((file) =>
    /^market-research-cache_endedAt-.*\.sqlite$/.test(file)).sort();
  if (!files.length) throw new Error('No completed SQLite caches');
  return resolve(CACHE_DIR, files[files.length - 1]);
}

function featureValue(sample: ForecastSample): Features {
  const ratio = sample.speeds[3] === 0 ? NaN :
    sample.speeds[0] / sample.speeds[3];
  return {
    curvature: sample.curvature ?? NaN,
    speedRatio: ratio,
    absV7: Math.abs(sample.speeds[0]),
    contrast: sample.contrast ?? NaN,
  };
}

function intervalLabel(name: FeatureName, index: number): string {
  const bounds = FEATURE_BUCKETS[name];
  const left = index === 0 ? '-inf' : String(bounds[index - 1]);
  const right = index === bounds.length ? '+inf' : String(bounds[index]);
  return `[${left},${right})`;
}

function newAggregate(key: string[]): Aggregate {
  return {
    key, signals: 0, spacedSignals: 0, valid: 0,
    spacedValid: 0, missingFill: 0, missingTarget: 0,
    early: 0, remaining: 0, net: 0, actualDelayMs: 0,
    wins: 0, spacedEarly: 0, spacedRemaining: 0,
    spacedNet: 0, spacedWins: 0,
    matchedValid: 0, matchedRemaining: 0, matchedNet: 0,
    matchedSpacedValid: 0, matchedSpacedNet: 0,
  };
}

const METRIC_HEADER = [
  'signals', 'spacedSignals', 'valid', 'spacedValid',
  'missingFill', 'missingTarget', 'validRate',
  'meanActualDelayMs', 'meanEarlyPermille',
  'meanRemainingPermille', 'meanNetPermille', 'netWinRate',
  'spacedMeanEarlyPermille', 'spacedMeanRemainingPermille',
  'spacedMeanNetPermille', 'spacedNetWinRate',
  'matchedValid', 'matchedMeanRemainingPermille',
  'matchedMeanNetPermille', 'matchedSpacedValid',
  'matchedSpacedMeanNetPermille',
];

function metricColumns(s: Aggregate): number[] {
  return [
    s.signals, s.spacedSignals, s.valid, s.spacedValid,
    s.missingFill, s.missingTarget,
    s.signals ? s.valid / s.signals : NaN,
    s.valid ? s.actualDelayMs / s.valid : NaN,
    s.valid ? s.early / s.valid : NaN,
    s.valid ? s.remaining / s.valid : NaN,
    s.valid ? s.net / s.valid : NaN,
    s.valid ? s.wins / s.valid : NaN,
    s.spacedValid ? s.spacedEarly / s.spacedValid : NaN,
    s.spacedValid ? s.spacedRemaining / s.spacedValid : NaN,
    s.spacedValid ? s.spacedNet / s.spacedValid : NaN,
    s.spacedValid ? s.spacedWins / s.spacedValid : NaN,
    s.matchedValid,
    s.matchedValid ? s.matchedRemaining / s.matchedValid : NaN,
    s.matchedValid ? s.matchedNet / s.matchedValid : NaN,
    s.matchedSpacedValid,
    s.matchedSpacedValid ? s.matchedSpacedNet /
      s.matchedSpacedValid : NaN,
  ];
}

// Each signal is resolved at the first tick >= the requested timestamp.
// Future t+60 values are NEVER used when selecting entry prices or bins.
export class ExecutionDelayStudy {
  private readonly queues: Queue[] = ENTRY_DELAYS_MS.map(() => ({
    records: [], head: 0,
  }));
  private readonly targetQueue: Queue = { records: [], head: 0 };
  private readonly all = new Map<string, Aggregate>();
  private readonly byMarket = new Map<string, Aggregate>();
  private readonly byFeature = new Map<string, Aggregate>();
  private readonly lastSpaced = new Map<string, number>();
  private selected = 0;

  constructor(private readonly samples: CsvSink | null) {}

  get selectedCount(): number { return this.selected; }

  private aggregate(
    map: Map<string, Aggregate>, key: string[],
  ): Aggregate {
    const id = key.join('|');
    let result = map.get(id);
    if (!result) {
      result = newAggregate(key);
      map.set(id, result);
    }
    return result;
  }

  // Receives only completed signals, including missing fills/targets.
  private complete(record: Signal): void {
    const base = [record.period, record.group];
    const buckets: { map: Map<string, Aggregate>; key: string[] }[] = [
      { map: this.all, key: base },
      { map: this.byMarket, key: [...base, record.market] },
    ];
    for (const name of Object.keys(FEATURE_BUCKETS) as FeatureName[]) {
      const value = record.features[name];
      const label = Number.isFinite(value) ?
        intervalLabel(name, bin(value, FEATURE_BUCKETS[name])) :
        'unavailable';
      buckets.push({
        map: this.byFeature, key: [...base, name, label],
      });
    }

    // Compare the same signals across delays, not just the available
    // subset of each delay. This avoids missing-price selection bias.
    const matched = record.target !== null &&
      record.fills.every((fill) => fill !== null);
    for (let i = 0; i < ENTRY_DELAYS_MS.length; i++) {
      const fill = record.fills[i];
      const target = record.target;
      const delay = ENTRY_DELAYS_MS[i] / 1000;
      for (const bucket of buckets) {
        const a = this.aggregate(bucket.map, [...bucket.key, String(delay)]);
        a.signals++;
        a.spacedSignals += Number(record.spaced);
        if (!fill) a.missingFill++;
        if (!target) a.missingTarget++;
        if (!fill || !target) continue;
        const early = 1000 * Math.log(fill.price / record.price);
        const remaining = 1000 * Math.log(target.price / fill.price);
        const net = remaining - COST_PER_ROUNDTRIP;
        a.valid++;
        a.early += early;
        a.remaining += remaining;
        a.net += net;
        if (matched) {
          a.matchedValid++;
          a.matchedRemaining += remaining;
          a.matchedNet += net;
          if (record.spaced) {
            a.matchedSpacedValid++;
            a.matchedSpacedNet += net;
          }
        }
        a.actualDelayMs += fill.t - record.t;
        a.wins += Number(net > 0);
        if (record.spaced) {
          a.spacedValid++;
          a.spacedEarly += early;
          a.spacedRemaining += remaining;
          a.spacedNet += net;
          a.spacedWins += Number(net > 0);
        }
      }
    }
    if (this.samples) this.samples.add([
      record.period, record.market, record.group, record.t,
      record.price, Number(record.spaced), Number(matched),
      record.target ? 1000 * Math.log(record.target.price / record.price) :
        null, record.forecast.value,
      record.forecast.direct, record.forecast.derived,
      record.forecast.directCell, record.forecast.derivedCell,
      record.forecast.pairCell, ...record.forecast.speeds,
      record.features.curvature, record.features.speedRatio,
      record.features.absV7, record.features.contrast,
      record.target?.t ?? null, record.target?.price ?? null,
      ...record.fills.flatMap((fill) => [
        fill?.t ?? null, fill?.price ?? null,
        fill ? fill.t - record.t : null,
        fill && record.target ?
          1000 * Math.log(fill.price / record.price) : null,
        fill && record.target ?
          1000 * Math.log(record.target.price / fill.price) : null,
        fill && record.target ?
          1000 * Math.log(record.target.price / fill.price) -
            COST_PER_ROUNDTRIP : null,
      ]),
    ]);
  }

  private resolve(record: Signal): void {
    record.unresolved--;
    if (record.unresolved === 0) this.complete(record);
  }

  // Flush at market and validation/test boundaries: no cross-market
  // and no test-period prices leaking into validation outcomes.
  flushPending(): void {
    for (let i = 0; i < this.queues.length; i++) {
      const queue = this.queues[i];
      for (let j = queue.head; j < queue.records.length; j++) {
        this.resolve(queue.records[j]);
      }
      queue.records = [];
      queue.head = 0;
    }
    const target = this.targetQueue;
    for (let j = target.head; j < target.records.length; j++) {
      this.resolve(target.records[j]);
    }
    target.records = [];
    target.head = 0;
    this.lastSpaced.clear();
  }

  onTick(
    tick: Tick, period: Period, market: string,
    sample: ForecastSample, decision: boolean,
  ): void {
    for (let i = 0; i < ENTRY_DELAYS_MS.length; i++) {
      const queue = this.queues[i];
      let head = queue.head;
      const delay = ENTRY_DELAYS_MS[i];
      while (head < queue.records.length) {
        const record = queue.records[head];
        if (tick.t <= record.t || tick.t < record.t + delay) break;
        head++;
        if (tick.t - record.t - delay <= MAX_PRICE_LATENESS_MS) {
          record.fills[i] = { t: tick.t, price: tick.p };
        }
        this.resolve(record);
      }
      if (head >= 4096 && head * 2 >= queue.records.length) {
        queue.records.splice(0, head);
        head = 0;
      }
      queue.head = head;
    }
    const target = this.targetQueue;
    let head = target.head;
    while (head < target.records.length &&
      tick.t >= target.records[head].t + TARGET_HORIZON_MS) {
      const record = target.records[head++];
      if (tick.t - record.t - TARGET_HORIZON_MS <=
        MAX_PRICE_LATENESS_MS) {
        record.target = { t: tick.t, price: tick.p };
      }
      this.resolve(record);
    }
    if (head >= 4096 && head * 2 >= target.records.length) {
      target.records.splice(0, head);
      head = 0;
    }
    target.head = head;

    if (!decision || sample.value === null ||
      sample.source !== 'combined') return;
    const group: TargetSignal | undefined = TARGET_SIGNALS.find((s) =>
      Math.abs(s.value - sample.value!) <= TARGET_TOLERANCE);
    if (!group) return;
    const last = this.lastSpaced.get(group.name) ?? -Infinity;
    const spaced = tick.t - last >= INDEPENDENT_SAMPLE_SPACING_MS;
    if (spaced) this.lastSpaced.set(group.name, tick.t);
    const record: Signal = {
      period, market, group: group.name, t: tick.t,
      price: tick.p, spaced, forecast: sample,
      features: featureValue(sample),
      fills: ENTRY_DELAYS_MS.map(() => null), target: null,
      unresolved: ENTRY_DELAYS_MS.length + 1,
    };
    for (const queue of this.queues) queue.records.push(record);
    this.targetQueue.records.push(record);
    this.selected++;
  }

  files(): Record<string, string> {
    const create = (map: Map<string, Aggregate>, head: string[]) => [
      csv([...head, 'delaySeconds', ...METRIC_HEADER]),
      ...[...map.values()].sort((a, b) =>
        a.key.join('|').localeCompare(b.key.join('|'))).map((a) =>
        csv([...a.key, ...metricColumns(a)])),
    ].join('\n') + '\n';
    return {
      'delay-summary.csv': create(this.all, ['period', 'group']),
      'delay-by-market.csv': create(this.byMarket,
        ['period', 'group', 'market']),
      'delay-by-feature.csv': create(this.byFeature,
        ['period', 'group', 'feature', 'bucket']),
    };
  }
}

async function main(): Promise<void> {
  console.log('[startup] Selecting cache...');
  const cache = await newestCache();
  console.log(`[startup] Opening ${cache}`);
  const db = new DatabaseSync(cache, { readOnly: true });
  let sink: CsvSink | null = null;
  try {
    const version = db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (version.user_version !== 1) {
      throw new Error(`Expected cache schema v1, got ${version.user_version}`);
    }
    console.log('[startup] Reading small market_cache_stats table...');
    const range = db.prepare(`
      SELECT MAX(last_received_at) AS last FROM market_cache_stats
    `).get() as { last: number | null };
    if (range.last === null || range.last <= FROZEN_END) {
      throw new Error('No new observations after frozen table cutoff');
    }
    const splitAt = Math.floor(FROZEN_END +
      (range.last - FROZEN_END) * VALIDATION_FRACTION);
    console.log('[startup] Selecting markets...');
    const markets = (db.prepare(`
      SELECT id, name, money FROM markets
      WHERE type = 'spot' AND EXISTS (
        SELECT 1 FROM observations WHERE market_id = markets.id
      ) ORDER BY name
    `).all() as Market[]).filter((m) =>
      QUOTE_CURRENCIES.includes(m.money) &&
      (!MARKET_NAMES.length || MARKET_NAMES.includes(m.name)));
    if (!markets.length) throw new Error('No eligible markets');
    console.log('[startup] Creating CSV output...');
    await mkdir(OUTPUT_DIR, { recursive: true });
    const output = await mkdtemp(resolve(OUTPUT_DIR, 'run-'));
    if (SAVE_SIGNAL_SAMPLES) {
      sink = new CsvSink(resolve(output, 'delay-samples.csv'), [
        'period', 'market', 'group', 'signalAt', 'signalPrice',
        'spaced60s', 'allDelaysMatched', 'signalTo60s',
        'combinedForecast', 'directForecast',
        'derivedForecast', 'directCell', 'derivedCell', 'pairCell',
        'v7', 'v15', 'v30', 'v60', 'curvature', 'speedRatio',
        'absV7', 'contrast', 'targetAt', 'targetPrice',
        ...ENTRY_DELAYS_MS.flatMap((ms) => {
          const d = ms / 1000;
          return [
            `fillAt${d}s`, `fillPrice${d}s`, `actualDelayMs${d}s`,
            `early${d}s`, `remaining${d}s`, `net${d}s`,
          ];
        }),
      ]);
    }
    const study = new ExecutionDelayStudy(sink);
    console.log(`Markets: ${markets.length}; output: ${output}`);
    console.log(`Validation: ${FROZEN_TABLE_END_ISO} to ` +
      new Date(splitAt).toISOString());
    console.log(`Test: ${new Date(splitAt).toISOString()} to ` +
      new Date(range.last).toISOString());
    console.log(`Delays (seconds): ${ENTRY_DELAYS_MS.map((x) => x / 1000)}`);
    console.log(`Round-trip cost: ${COST_PER_ROUNDTRIP.toFixed(6)}‰`);
    console.log('[start] Processing cached observations...');

    for (let i = 0; i < markets.length; i++) {
      const market = markets[i];
      const predictor = new Forecast();
      let currentPeriod: Period | null = null;
      let previousDecision = -Infinity;
      let ticks = 0;
      let lastProgress = Date.now();
      console.log(`[market] ${market.name}: started (${i + 1}/${markets.length})`);
      for (const tick of readTicks(db, market.id)) {
        ticks++;
        if (ticks % PROGRESS_TICKS_INTERVAL === 0 &&
          Date.now() - lastProgress >= PROGRESS_INTERVAL_MS) {
          console.log(`[market] ${market.name}: ` +
            `${ticks.toLocaleString()} ticks, ` +
            `through ${new Date(tick.t).toISOString()}`);
          lastProgress = Date.now();
        }
        const forecast = predictor.update(tick.t, tick.p);
        if (tick.t <= FROZEN_END) continue;
        const period = tick.t < splitAt ? 'validation' : 'test';
        if (period !== currentPeriod) {
          study.flushPending();
          currentPeriod = period;
          previousDecision = -Infinity;
        }
        const decision = tick.t - previousDecision >= DECISION_INTERVAL_MS;
        if (decision) previousDecision = tick.t;
        study.onTick(tick, period, market.name, forecast, decision);
      }
      study.flushPending();
      console.log(`[progress] ${i + 1}/${markets.length} markets; ` +
        `${ticks.toLocaleString()} ticks on ${market.name}; ` +
        `signals=${study.selectedCount.toLocaleString()}`);
    }
    console.log('[save] Writing grouped reports...');
    for (const [name, content] of Object.entries(study.files())) {
      await writeFile(resolve(output, name), content);
    }
    sink?.close();
    sink = null;
    await writeFile(resolve(output, 'run.json'), JSON.stringify({
      cache: basename(cache), frozenTableEnd: FROZEN_TABLE_END_ISO,
      splitAt: new Date(splitAt).toISOString(),
      lastTick: new Date(range.last).toISOString(),
      markets: markets.length, quoteCurrencies: QUOTE_CURRENCIES,
      targetSignals: TARGET_SIGNALS, selectedSignals: study.selectedCount,
      entryDelaysMs: ENTRY_DELAYS_MS,
      targetHorizonMs: TARGET_HORIZON_MS,
      maxPriceLatenessMs: MAX_PRICE_LATENESS_MS,
      decisionIntervalMs: DECISION_INTERVAL_MS,
      independentSampleSpacingMs: INDEPENDENT_SAMPLE_SPACING_MS,
      roundTripCostLogPermille: COST_PER_ROUNDTRIP,
      features: FEATURE_BUCKETS,
      signalSamplesSaved: SAVE_SIGNAL_SAMPLES,
      metric: 'log-return t+60s over delayed first-next tick price',
      matchedPolicy: 'matched metrics use signals with all six fills and t+60',
      note: 'This is NOT a strategy backtest; no order book/spread/borrow costs',
      splitPolicy: 'unresolved signals discarded across period boundary',
    }, null, 2) + '\n');
    console.log(`Finished: ${output}`);
  } finally {
    try { sink?.close(); } finally { db.close(); }
  }
}

// Keep the study importable by a small independent test harness.
if (process.argv[1]?.endsWith('market-forecast-execution-delay-v4.ts') ||
  process.argv[1]?.endsWith('market-forecast-execution-delay-v4.js')) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
