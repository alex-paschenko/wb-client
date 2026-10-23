// app/src/server/research/market-rebound-research-v6.ts
// Run from app: node --import tsx src/server/research/market-rebound-research-v6.ts
// Causal drop episodes, EMA features, delayed fills, forward outcomes.
// Diagnostic research only: last-trade prices are not executable quotes.

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
const OUTPUT_DIR = resolve('research-output/market-rebound-research-v6');
const FROZEN_TABLE_END_ISO = '2026-10-02T01:40:49.395Z';
const VALIDATION_FRACTION = 0.5;
const QUOTE_CURRENCIES = ['USD', 'USDT'];
const MARKET_NAMES: string[] = []; // Empty: all eligible spot markets.

// All thresholds are research hypotheses, not optimized parameters.
const TRIGGER_DROP_PERMILLE = 3;
const REARM_DROP_PERMILLE = 1.5;
const DROP_LOOKBACK_MS = 60_000;
const MIN_LOOKBACK_SPAN_MS = 30_000;
const MIN_LOOKBACK_SAMPLES = 10;
const EPISODE_STAGES_MS = [0, 2000, 5000, 10_000, 20_000, 30_000, 60_000];
const EPISODE_COOLDOWN_MS = 240_000;
const ENTRY_DELAYS_MS = [0, 1000, 2000, 3000, 5000, 10_000];
const HORIZONS_MS = [10_000, 30_000, 60_000, 120_000];
const FIRST_PASSAGE_HORIZON_MS = 120_000;
const UP_BARRIER_PERMILLE = 3;
const DOWN_BARRIER_PERMILLE = 2;
const MAX_PRICE_LATENESS_MS = 10_000;
const MAX_TICK_GAP_MS = 60_000;
const DECISION_INTERVAL_MS = 1000;
const FEE_PER_SIDE_PERMILLE = 1;
const SLIPPAGE_PER_SIDE_PERMILLE = 0;
const SAVE_SAMPLED_SIGNALS = true;
const SAMPLE_ONE_IN_EPISODES = 10; // Deterministic per-market sample.
const PROGRESS_INTERVAL_MS = 10_000;
const PROGRESS_TICK_INTERVAL = 4096;

const TAUS_MS = [7000, 15_000, 30_000, 60_000];
const FROZEN_END = Date.parse(FROZEN_TABLE_END_ISO);
const PERIODS = ['validation', 'test'] as const;
const FEATURE_BINS = {
  triggerDrop: [3.5, 4, 5, 7, 10, 15, 25],
  currentDrawdown: [0.5, 1, 2, 3, 4, 6, 10, 15],
  reboundFromLow: [0.5, 1, 2, 3, 5, 8, 15],
  recentReturn5s: [-10, -5, -2, -1, 0, 1, 2, 5, 10],
  v7Delta5s: [-60, -20, -10, -5, -2, 0, 2, 5, 10, 20, 60],
  v7MinusV30: [-50, -20, -10, -5, 0, 5, 10, 20, 50],
  curvature: [-200, -100, -20, 0, 20, 100, 200],
  combined: [-4, -2, -1, 0, 1, 2, 3, 3.5, 4],
  realizedVol60: [1, 2, 4, 8, 16, 32],
} as const;

if (!Number.isFinite(FROZEN_END) ||
  EPISODE_STAGES_MS.at(-1)! + ENTRY_DELAYS_MS.at(-1)! +
  FIRST_PASSAGE_HORIZON_MS + MAX_PRICE_LATENESS_MS >=
  EPISODE_COOLDOWN_MS) {
  throw new Error('Invalid dates or episode cooldown');
}

const COST_PER_ROUNDTRIP = (() => {
  const fee = FEE_PER_SIDE_PERMILLE / 1000;
  const slip = SLIPPAGE_PER_SIDE_PERMILLE / 1000;
  if (fee < 0 || fee >= 1 || slip < 0 || slip >= 1) {
    throw new Error('Invalid cost');
  }
  return 1000 * (Math.log1p(fee) - Math.log1p(-fee) +
    Math.log1p(slip) - Math.log1p(-slip));
})();

type Period = typeof PERIODS[number];
type Market = { id: number; name: string; money: string };
type Tick = { t: number; p: number };
type FeatureName = keyof typeof FEATURE_BINS;
type Features = Record<FeatureName, number> & {
  v7: number;
  v15: number;
  v30: number;
  v60: number;
  direct: number | null;
  derived: number | null;
  peakAgeSeconds: number;
  lowAgeSeconds: number;
};
type ForecastValue = { speeds: number[]; combined: number | null;
  direct: number | null; derived: number | null; curvature: number };
type Snapshot = {
  t: number;
  p: number;
  log: number;
  v7: number;
  v30: number;
  stepSquared: number;
};
type Outcome = 'up' | 'down' | 'neither' | 'censored';
type Fill = {
  t: number;
  p: number;
  result: (number | null)[];
  barrier: Outcome;
  hitAfterMs: number | null;
  mfe: number;
  mae: number;
  finished: boolean;
};
type Candidate = {
  period: Period;
  market: string;
  episode: number;
  stage: number;
  t: number;
  price: number;
  features: Features;
  fills: (Fill | null)[];
  resolved: boolean[];
};
type Episode = {
  triggerAt: number;
  nextStage: number;
  candidates: Candidate[];
};
type Summary = {
  signals: number;
  missingFills: number;
  censored: number;
  completed: number;
  up: number;
  down: number;
  neither: number;
  hitMs: number;
  actualDelay: number;
  mfe: number;
  mae: number;
  returnCounts: number[];
  returnSums: number[];
  returnWins: number[];
  cappedNet60: number;
  matched60Count: number;
  matched60Net: number;
};

function bin(x: number, borders: readonly number[]): number {
  for (let i = 0; i < borders.length; i++) {
    if (x < borders[i]) return i;
  }
  return borders.length;
}

function csv(values: (string | number | null)[]): string {
  return values.map((v) => {
    if (v === null || typeof v === 'number' && !Number.isFinite(v)) {
      return '';
    }
    const value = String(v);
    return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
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
      offset += writeSync(this.fd, buffer, offset, buffer.length - offset);
    }
    this.lines.length = 0;
    this.bytes = 0;
  }

  close(): void {
    try { this.flush(); } finally { closeSync(this.fd); }
  }
}

// Same EMA recurrence and frozen table indexing as v3/v5.
class Forecast {
  private readonly ema = new Float64Array(4);
  private first = NaN;
  private previous = NaN;

  update(t: number, p: number): ForecastValue {
    if (!(p > 0) || !Number.isFinite(p)) {
      throw new Error('Invalid observation price');
    }
    const x = 1000 * Math.log(p);
    if (!Number.isFinite(this.previous)) {
      this.ema.fill(x);
      this.first = t;
    } else {
      if (t <= this.previous) throw new Error('Non-increasing ticks');
      const dt = t - this.previous;
      for (let i = 0; i < 4; i++) {
        this.ema[i] += -Math.expm1(-dt / TAUS_MS[i]) *
          (x - this.ema[i]);
      }
    }
    this.previous = t;
    const v = TAUS_MS.map((tau, i) =>
      (x - this.ema[i]) / (tau / 60_000));
    const age = t - this.first;
    let direct: number | null = null;
    let derived: number | null = null;
    let curvature = NaN;

    if (age >= 150_000 && v[2] !== 0) {
      const sign = Math.sign(v[2]);
      const cell = (bin(v[0] * sign, MARKET_FORECAST_ALIGNED_BINS) *
        (MARKET_FORECAST_ALIGNED_BINS.length + 1) +
        bin(v[1] * sign, MARKET_FORECAST_ALIGNED_BINS)) *
        (MARKET_FORECAST_SLOW_BINS.length + 1) +
        bin(Math.abs(v[2]), MARKET_FORECAST_SLOW_BINS);
      const value = MARKET_FORECAST_3_EMA[cell];
      if (Number.isFinite(value)) direct = sign * value;
    }
    if (age >= 300_000 && v[3] !== 0) {
      const sign = Math.sign(v[3]);
      const contrast = (v[0] - v[2]) * sign;
      curvature = ((v[0] - v[1]) / ((15 - 7) / 60) -
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
    let combined = direct ?? derived;
    if (direct !== null && derived !== null) {
      const cell = bin(direct, MARKET_FORECAST_PAIR_BINS) *
        (MARKET_FORECAST_PAIR_BINS.length + 1) +
        bin(derived, MARKET_FORECAST_PAIR_BINS);
      combined = (direct + derived) / 2 +
        MARKET_FORECAST_COMBINED_CORRECTION[cell];
    }
    return { speeds: v, direct, derived, combined, curvature };
  }
}

// Maintains causal one-second snapshots and a rolling max/min in O(1).
class PriceHistory {
  private readonly points: Snapshot[] = [];
  private readonly highs: Snapshot[] = [];
  private readonly lows: Snapshot[] = [];
  private volSquared = 0;

  clear(): void {
    this.points.length = 0;
    this.highs.length = 0;
    this.lows.length = 0;
    this.volSquared = 0;
  }

  push(tick: Tick, f: ForecastValue): void {
    const log = Math.log(tick.p);
    const previous = this.points.at(-1);
    const stepSquared = previous ?
      Math.pow(1000 * (log - previous.log), 2) : 0;
    const point: Snapshot = {
      t: tick.t, p: tick.p, log, v7: f.speeds[0],
      v30: f.speeds[2], stepSquared,
    };
    this.points.push(point);
    this.volSquared += stepSquared;
    while (this.highs.length && this.highs.at(-1)!.p <= tick.p) {
      this.highs.pop();
    }
    while (this.lows.length && this.lows.at(-1)!.p >= tick.p) {
      this.lows.pop();
    }
    this.highs.push(point);
    this.lows.push(point);
    const earliest = tick.t - DROP_LOOKBACK_MS;
    while (this.points.length && this.points[0].t < earliest) {
      const removed = this.points.shift()!;
      this.volSquared -= removed.stepSquared;
      if (this.highs[0] === removed) this.highs.shift();
      if (this.lows[0] === removed) this.lows.shift();
    }
    // The first retained step used a now-discarded predecessor.
    if (this.points.length > 0 && this.points[0].stepSquared !== 0) {
      this.volSquared -= this.points[0].stepSquared;
      this.points[0].stepSquared = 0;
    }
    this.volSquared = Math.max(0, this.volSquared);
  }

  eligible(): boolean {
    return this.points.length >= MIN_LOOKBACK_SAMPLES &&
      this.points.at(-1)!.t - this.points[0].t >=
      MIN_LOOKBACK_SPAN_MS;
  }

  drop(): number {
    const latest = this.points.at(-1);
    const high = this.highs[0];
    return latest && high ? 1000 * Math.log(high.p / latest.p) : 0;
  }

  features(f: ForecastValue, triggerDrop: number): Features {
    const last = this.points.at(-1)!;
    const low = this.lows[0];
    const high = this.highs[0];
    const past5 = this.previousAt(last.t - 5000);
    return {
      triggerDrop,
      currentDrawdown: 1000 * Math.log(high.p / last.p),
      reboundFromLow: 1000 * Math.log(last.p / low.p),
      recentReturn5s: past5 ? 1000 * (last.log - past5.log) : NaN,
      v7Delta5s: past5 ? f.speeds[0] - past5.v7 : NaN,
      v7MinusV30: f.speeds[0] - f.speeds[2],
      curvature: f.curvature,
      combined: f.combined ?? NaN,
      realizedVol60: Math.sqrt(this.volSquared),
      v7: f.speeds[0], v15: f.speeds[1],
      v30: f.speeds[2], v60: f.speeds[3],
      direct: f.direct, derived: f.derived,
      peakAgeSeconds: (last.t - high.t) / 1000,
      lowAgeSeconds: (last.t - low.t) / 1000,
    };
  }

  private previousAt(t: number): Snapshot | null {
    for (let i = this.points.length - 1; i >= 0; i--) {
      if (this.points[i].t <= t) {
        return t - this.points[i].t <= MAX_PRICE_LATENESS_MS ?
          this.points[i] : null;
      }
    }
    return null;
  }
}

function zeroSummary(): Summary {
  return {
    signals: 0, missingFills: 0, censored: 0, completed: 0,
    up: 0, down: 0, neither: 0, hitMs: 0,
    actualDelay: 0, mfe: 0, mae: 0,
    returnCounts: HORIZONS_MS.map(() => 0),
    returnSums: HORIZONS_MS.map(() => 0),
    returnWins: HORIZONS_MS.map(() => 0),
    cappedNet60: 0, matched60Count: 0, matched60Net: 0,
  };
}

const SUMMARY_HEADERS = [
  'signals', 'filled', 'missingFills', 'censored',
  'completed120s', 'upFirst', 'downFirst', 'neither',
  'upRateOfCompleted', 'downRateOfCompleted',
  'meanFirstHitSeconds', 'meanActualEntryDelayMs',
  'meanMfe120Permille', 'meanMae120Permille',
  ...HORIZONS_MS.flatMap((ms) => [
    `n${ms / 1000}s`, `meanNet${ms / 1000}sPermille`,
    `winRate${ms / 1000}s`,
  ]),
  'cappedMeanNet60Permille', 'matchedN60s',
  'matchedMeanNet60Permille',
];

function summaryColumns(s: Summary): number[] {
  const filled = s.signals - s.missingFills;
  const hits = s.up + s.down;
  const sixty = HORIZONS_MS.indexOf(60_000);
  return [
    s.signals, filled, s.missingFills, s.censored,
    s.completed, s.up, s.down, s.neither,
    s.completed ? s.up / s.completed : NaN,
    s.completed ? s.down / s.completed : NaN,
    hits ? s.hitMs / hits / 1000 : NaN,
    filled ? s.actualDelay / filled : NaN,
    s.completed ? s.mfe / s.completed : NaN,
    s.completed ? s.mae / s.completed : NaN,
    ...HORIZONS_MS.flatMap((_, i) => [
      s.returnCounts[i],
      s.returnCounts[i] ? s.returnSums[i] / s.returnCounts[i] : NaN,
      s.returnCounts[i] ? s.returnWins[i] / s.returnCounts[i] : NaN,
    ]),
    s.returnCounts[sixty] ? s.cappedNet60 /
      s.returnCounts[sixty] : NaN,
    s.matched60Count,
    s.matched60Count ? s.matched60Net / s.matched60Count : NaN,
  ];
}

class ResearchResults {
  private readonly overall = new Map<string, Summary>();
  private readonly byMarket = new Map<string, Summary>();
  private readonly byFeature = new Map<string, Summary>();
  private readonly coverage = new Map<string, { eligible: number; created: number }>();
  private episodes = 0;
  private signals = 0;

  constructor(private readonly sampleSink: CsvSink | null) {}

  newEpisode(): number { return ++this.episodes; }
  get episodeCount(): number { return this.episodes; }
  get signalCount(): number { return this.signals; }

  stageCoverage(period: Period, stage: number, created: boolean): void {
    const key = `${period}|${stage}`;
    const s = this.coverage.get(key) ?? { eligible: 0, created: 0 };
    s.eligible++;
    s.created += Number(created);
    this.coverage.set(key, s);
    if (created) this.signals++;
  }

  private get(map: Map<string, Summary>, parts: string[]): Summary {
    const key = parts.join('|');
    let s = map.get(key);
    if (!s) {
      s = zeroSummary();
      map.set(key, s);
    }
    return s;
  }

  complete(c: Candidate): void {
    const si = HORIZONS_MS.indexOf(60_000);
    const matched = c.fills.every((fill) => fill !== null &&
      fill.result[si] !== null);
    for (let i = 0; i < ENTRY_DELAYS_MS.length; i++) {
      const fill = c.fills[i];
      const base = [c.period, String(c.stage),
        String(ENTRY_DELAYS_MS[i] / 1000)];
      const aggregates: Summary[] = [
        this.get(this.overall, base),
        this.get(this.byMarket, [...base, c.market]),
      ];
      for (const name of Object.keys(FEATURE_BINS) as FeatureName[]) {
        const value = c.features[name];
        const bounds = FEATURE_BINS[name];
        const bucket = Number.isFinite(value) ?
          String(bin(value, bounds)) : 'missing';
        aggregates.push(this.get(this.byFeature,
          [...base, name, bucket]));
      }
      for (const s of aggregates) {
        s.signals++;
        if (!fill) { s.missingFills++; continue; }
        s.actualDelay += fill.t - c.t;
        if (fill.barrier === 'censored') s.censored++;
        else {
          s.completed++;
          if (fill.barrier === 'up') s.up++;
          else if (fill.barrier === 'down') s.down++;
          else s.neither++;
          if (fill.hitAfterMs !== null) s.hitMs += fill.hitAfterMs;
          s.mfe += fill.mfe;
          s.mae += fill.mae;
        }
        fill.result.forEach((ret, j) => {
          if (ret === null) return;
          const net = ret - COST_PER_ROUNDTRIP;
          s.returnCounts[j]++;
          s.returnSums[j] += net;
          s.returnWins[j] += Number(net > 0);
          if (j === si) s.cappedNet60 += Math.max(-20, Math.min(20, net));
        });
        if (matched) {
          s.matched60Count++;
          s.matched60Net += fill.result[si]! - COST_PER_ROUNDTRIP;
        }
      }
    }
    if (this.sampleSink && c.episode % SAMPLE_ONE_IN_EPISODES === 0) {
      this.sampleSink.add([
        c.period, c.market, c.episode, c.stage, c.t, c.price,
        ...Object.keys(FEATURE_BINS).map((name) =>
          c.features[name as FeatureName]),
        c.features.v7, c.features.v15, c.features.v30,
        c.features.v60, c.features.direct, c.features.derived,
        c.features.peakAgeSeconds, c.features.lowAgeSeconds,
        ...c.fills.flatMap((fill) => [
          fill?.t ?? null, fill?.p ?? null,
          fill ? fill.t - c.t : null,
          fill ? fill.barrier : null,
          fill?.hitAfterMs ?? null,
          ...HORIZONS_MS.map((_, j) =>
            fill?.result[j] === null || !fill ? null :
              fill.result[j]! - COST_PER_ROUNDTRIP),
        ]),
      ]);
    }
  }

  files(): Record<string, string> {
    const print = (map: Map<string, Summary>, prefix: string[]) => [
      csv([...prefix, ...SUMMARY_HEADERS]),
      ...[...map].sort(([a], [b]) => a.localeCompare(b))
        .map(([key, s]) => csv([...key.split('|'), ...summaryColumns(s)])),
    ].join('\n') + '\n';
    const coverage = [csv([
      'period', 'stageSeconds', 'eligibleEpisodes',
      'signalsCreated', 'missingStagePrices',
    ])];
    for (const [key, s] of [...this.coverage].sort()) {
      const [period, stage] = key.split('|');
      coverage.push(csv([
        period, stage, s.eligible, s.created, s.eligible - s.created,
      ]));
    }
    const features = [csv([
      'feature', 'bucket', 'lowerInclusive', 'upperExclusive',
    ])];
    for (const name of Object.keys(FEATURE_BINS) as FeatureName[]) {
      const bounds = FEATURE_BINS[name];
      for (let i = 0; i <= bounds.length; i++) {
        features.push(csv([
          name, i, i === 0 ? null : bounds[i - 1],
          i === bounds.length ? null : bounds[i],
        ]));
      }
    }
    return {
      'stage-summary.csv': print(this.overall,
        ['period', 'stageSeconds', 'entryDelaySeconds']),
      'stage-by-market.csv': print(this.byMarket,
        ['period', 'stageSeconds', 'entryDelaySeconds', 'market']),
      'stage-by-feature.csv': print(this.byFeature,
        ['period', 'stageSeconds', 'entryDelaySeconds',
          'feature', 'bucket']),
      'stage-coverage.csv': coverage.join('\n') + '\n',
      'feature-bins.csv': features.join('\n') + '\n',
    };
  }
}

// Each market has at most one active episode; the 240s cooldown covers
// the entire 60s stage range and 120s forward observation horizon.
class MarketResearch {
  private readonly forecast = new Forecast();
  private readonly history = new PriceHistory();
  private episode: Episode | null = null;
  private lastEpisodeAt = -Infinity;
  private lastDecision = -Infinity;
  private lastTick: Tick | null = null;
  private period: Period | null = null;
  private ticks = 0;
  private episodes = 0;
  private armed = true;

  constructor(
    private readonly market: Market,
    private readonly splitAt: number,
    private readonly results: ResearchResults,
  ) {}

  private candidate(
    tick: Tick, f: ForecastValue, stage: number,
    triggerDrop: number, episode: number,
  ): Candidate {
    if (this.period === null) throw new Error('Missing period');
    return {
      period: this.period, market: this.market.name, episode,
      stage: stage / 1000, t: tick.t, price: tick.p,
      features: this.history.features(f, triggerDrop),
      fills: ENTRY_DELAYS_MS.map(() => null),
      resolved: ENTRY_DELAYS_MS.map(() => false),
    };
  }

  private finishCandidate(c: Candidate, force = false): void {
    if (force) {
      for (let i = 0; i < ENTRY_DELAYS_MS.length; i++) {
        if (c.resolved[i]) continue;
        if (c.fills[i]) {
          c.fills[i]!.barrier = 'censored';
          c.fills[i]!.finished = true;
        }
        c.resolved[i] = true;
      }
    }
    if (c.resolved.every(Boolean)) this.results.complete(c);
  }

  private stopEpisode(): void {
    if (!this.episode) return;
    for (const c of this.episode.candidates) {
      if (!c.resolved.every(Boolean)) this.finishCandidate(c, true);
    }
    // Future stages cannot be observed across a period/gap boundary.
    for (let j = this.episode.nextStage; j < EPISODE_STAGES_MS.length; j++) {
      this.results.stageCoverage(this.period!,
        EPISODE_STAGES_MS[j] / 1000, false);
    }
    this.episode = null;
  }

  private advanceCandidate(c: Candidate, tick: Tick): void {
    for (let i = 0; i < ENTRY_DELAYS_MS.length; i++) {
      if (c.resolved[i]) continue;
      let fill = c.fills[i];
      if (!fill) {
        const due = c.t + ENTRY_DELAYS_MS[i];
        if (tick.t <= c.t || tick.t < due) continue;
        if (tick.t - due > MAX_PRICE_LATENESS_MS) {
          c.resolved[i] = true;
          continue;
        }
        fill = {
          t: tick.t, p: tick.p,
          result: HORIZONS_MS.map(() => null),
          barrier: 'neither', hitAfterMs: null,
          mfe: 0, mae: 0, finished: false,
        };
        c.fills[i] = fill;
        continue;
      }
      const elapsed = tick.t - fill.t;
      if (elapsed <= FIRST_PASSAGE_HORIZON_MS) {
        const movement = 1000 * Math.log(tick.p / fill.p);
        fill.mfe = Math.max(fill.mfe, movement);
        fill.mae = Math.min(fill.mae, movement);
        if (fill.hitAfterMs === null) {
          if (movement >= UP_BARRIER_PERMILLE) {
            fill.barrier = 'up';
            fill.hitAfterMs = elapsed;
          } else if (movement <= -DOWN_BARRIER_PERMILLE) {
            fill.barrier = 'down';
            fill.hitAfterMs = elapsed;
          }
        }
      }
      HORIZONS_MS.forEach((horizon, j) => {
        if (fill.result[j] !== null || elapsed < horizon) return;
        if (elapsed - horizon <= MAX_PRICE_LATENESS_MS) {
          fill.result[j] = 1000 * Math.log(tick.p / fill.p);
        }
      });
      if (elapsed >= FIRST_PASSAGE_HORIZON_MS) {
        // If the end was not observed in time, the full 120s
        // path is censored, even if an earlier barrier was seen.
        if (elapsed - FIRST_PASSAGE_HORIZON_MS > MAX_PRICE_LATENESS_MS) {
          fill.barrier = 'censored';
        }
        fill.finished = true;
        c.resolved[i] = true;
      }
    }
    this.finishCandidate(c);
  }

  private advanceEpisode(
    tick: Tick, f: ForecastValue, decision: boolean,
  ): void {
    const episode = this.episode;
    if (!episode) return;
    for (const c of episode.candidates) {
      if (!c.resolved.every(Boolean)) this.advanceCandidate(c, tick);
    }
    if (decision) while (episode.nextStage < EPISODE_STAGES_MS.length &&
      tick.t >= episode.triggerAt +
        EPISODE_STAGES_MS[episode.nextStage]) {
      const stage = EPISODE_STAGES_MS[episode.nextStage++];
      const age = tick.t - episode.triggerAt - stage;
      const created = age <= MAX_PRICE_LATENESS_MS;
      this.results.stageCoverage(this.period!, stage / 1000, created);
      if (created) {
        const triggerDrop = episode.candidates[0].features.triggerDrop;
        episode.candidates.push(this.candidate(
          tick, f, stage, triggerDrop, episode.candidates[0].episode));
      }
    }
    if (tick.t - episode.triggerAt >= EPISODE_COOLDOWN_MS) {
      this.stopEpisode();
    }
  }

  run(db: DatabaseSync): void {
    const query = db.prepare(`
      SELECT received_at AS t, price AS p FROM observations
      WHERE market_id = ? ORDER BY received_at
    `);
    let lastProgress = Date.now();
    console.log(`[market] ${this.market.name}: started`);
    for (const row of query.iterate(this.market.id)) {
      const tick = row as Tick;
      this.ticks++;
      if (this.ticks % PROGRESS_TICK_INTERVAL === 0 &&
        Date.now() - lastProgress >= PROGRESS_INTERVAL_MS) {
        console.log(`[market] ${this.market.name}: ` +
          `${this.ticks.toLocaleString()} ticks; ` +
          `${new Date(tick.t).toISOString()}; episodes=${this.episodes}`);
        lastProgress = Date.now();
      }
      const forecast = this.forecast.update(tick.t, tick.p);
      const gap = this.lastTick !== null &&
        tick.t - this.lastTick.t > MAX_TICK_GAP_MS;
      const period: Period = tick.t < this.splitAt ?
        'validation' : 'test';
      if (this.period !== period || gap) {
        this.stopEpisode();
        this.history.clear();
        this.armed = true;
        this.lastDecision = -Infinity;
        this.period = period;
      }
      this.lastTick = tick;
      if (tick.t <= FROZEN_END) continue;
      // Forward prices are processed on EVERY tick, not just decisions.
      const decision = tick.t - this.lastDecision >= DECISION_INTERVAL_MS;
      if (decision) {
        this.lastDecision = tick.t;
        this.history.push(tick, forecast);
      }
      if (this.episode) this.advanceEpisode(tick, forecast, decision);
      if (!decision) continue;
      if (!this.history.eligible()) continue;
      const drop = this.history.drop();
      if (drop < REARM_DROP_PERMILLE) this.armed = true;
      if (this.episode || !this.armed ||
        tick.t - this.lastEpisodeAt < EPISODE_COOLDOWN_MS ||
        drop < TRIGGER_DROP_PERMILLE) continue;
      // Hysteresis: do not count one prolonged fall many times.
      this.armed = false;
      const episode = this.results.newEpisode();
      this.episodes++;
      this.lastEpisodeAt = tick.t;
      this.results.stageCoverage(period, 0, true);
      this.episode = {
        triggerAt: tick.t, nextStage: 1,
        candidates: [this.candidate(tick, forecast, 0, drop, episode)],
      };
    }
    this.stopEpisode();
    console.log(`[market] ${this.market.name}: done; ` +
      `${this.ticks.toLocaleString()} ticks, ` +
      `${this.episodes.toLocaleString()} episodes`);
  }
}

async function newestCache(): Promise<string> {
  if (CACHE_PATH) return resolve(CACHE_PATH);
  const names = (await readdir(CACHE_DIR)).filter((name) =>
    /^market-research-cache_endedAt-.*\.sqlite$/.test(name)).sort();
  if (!names.length) throw new Error('No completed cache');
  return resolve(CACHE_DIR, names.at(-1)!);
}

async function main(): Promise<void> {
  console.log('[startup] Selecting SQLite cache...');
  const cache = await newestCache();
  console.log(`[startup] Opening ${cache}`);
  const db = new DatabaseSync(cache, { readOnly: true });
  let sink: CsvSink | null = null;
  try {
    const version = db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (version.user_version !== 1) {
      throw new Error(`Expected SQLite v1, got ${version.user_version}`);
    }
    console.log('[startup] Reading market_cache_stats (small table)...');
    const range = db.prepare(`
      SELECT MAX(last_received_at) AS last FROM market_cache_stats
    `).get() as { last: number | null };
    if (range.last === null || range.last <= FROZEN_END) {
      throw new Error('No data after frozen training cutoff');
    }
    const splitAt = Math.floor(FROZEN_END +
      (range.last - FROZEN_END) * VALIDATION_FRACTION);
    console.log('[startup] Selecting eligible spot markets...');
    const markets = (db.prepare(`
      SELECT id, name, money FROM markets
      WHERE type = 'spot' AND EXISTS (
        SELECT 1 FROM observations WHERE market_id = markets.id
      ) ORDER BY name
    `).all() as Market[]).filter((m) =>
      QUOTE_CURRENCIES.includes(m.money) &&
      (!MARKET_NAMES.length || MARKET_NAMES.includes(m.name)));
    if (!markets.length) throw new Error('No eligible markets');
    console.log('[startup] Preparing CSV output...');
    await mkdir(OUTPUT_DIR, { recursive: true });
    const output = await mkdtemp(resolve(OUTPUT_DIR, 'run-'));
    if (SAVE_SAMPLED_SIGNALS) {
      sink = new CsvSink(resolve(output, 'sampled-signals.csv'), [
        'period', 'market', 'episode', 'stageSeconds',
        'signalAt', 'signalPrice',
        ...Object.keys(FEATURE_BINS),
        'v7', 'v15', 'v30', 'v60', 'direct', 'derived',
        'peakAgeSeconds', 'lowAgeSeconds',
        ...ENTRY_DELAYS_MS.flatMap((delay) => [
          `fillAt${delay / 1000}s`, `fillPrice${delay / 1000}s`,
          `actualEntryDelay${delay / 1000}sMs`,
          `firstHit${delay / 1000}s`,
          `firstHitAfter${delay / 1000}sMs`,
          ...HORIZONS_MS.map((h) =>
            `net${h / 1000}sAfterDelay${delay / 1000}s`),
        ]),
      ]);
    }
    const results = new ResearchResults(sink);
    console.log(`Markets: ${markets.length}; output: ${output}`);
    console.log(`Validation: ${FROZEN_TABLE_END_ISO} to ` +
      new Date(splitAt).toISOString());
    console.log(`Test: ${new Date(splitAt).toISOString()} to ` +
      new Date(range.last).toISOString());
    console.log(`Trigger: ${TRIGGER_DROP_PERMILLE}‰ in 60s; ` +
      `cooldown: ${EPISODE_COOLDOWN_MS / 1000}s`);
    console.log(`[start] Researching drop episodes and rebounds...`);
    for (let i = 0; i < markets.length; i++) {
      new MarketResearch(markets[i], splitAt, results).run(db);
      console.log(`[progress] ${i + 1}/${markets.length} markets ` +
        `(${(100 * (i + 1) / markets.length).toFixed(1)}%); ` +
        `episodes=${results.episodeCount.toLocaleString()}, ` +
        `signals=${results.signalCount.toLocaleString()}`);
    }
    console.log('[save] Writing aggregated reports...');
    for (const [name, content] of Object.entries(results.files())) {
      await writeFile(resolve(output, name), content);
    }
    sink?.close();
    sink = null;
    await writeFile(resolve(output, 'run.json'), JSON.stringify({
      cache: basename(cache), frozenTrainingEnd: FROZEN_TABLE_END_ISO,
      splitAt: new Date(splitAt).toISOString(),
      cacheLastTick: new Date(range.last).toISOString(),
      markets: markets.length, quoteCurrencies: QUOTE_CURRENCIES,
      episodes: results.episodeCount, candidateSignals: results.signalCount,
      triggerDropPermille: TRIGGER_DROP_PERMILLE,
      rearmDropPermille: REARM_DROP_PERMILLE,
      lookbackMs: DROP_LOOKBACK_MS,
      minLookbackSpanMs: MIN_LOOKBACK_SPAN_MS,
      minLookbackSamples: MIN_LOOKBACK_SAMPLES,
      stagesMs: EPISODE_STAGES_MS,
      cooldownMs: EPISODE_COOLDOWN_MS,
      entryDelaysMs: ENTRY_DELAYS_MS,
      horizonsMs: HORIZONS_MS,
      firstPassageHorizonMs: FIRST_PASSAGE_HORIZON_MS,
      upBarrierPermille: UP_BARRIER_PERMILLE,
      downBarrierPermille: DOWN_BARRIER_PERMILLE,
      roundTripLogCostPermille: COST_PER_ROUNDTRIP,
      maxPriceLatenessMs: MAX_PRICE_LATENESS_MS,
      maxTickGapMs: MAX_TICK_GAP_MS,
      decisionIntervalMs: DECISION_INTERVAL_MS,
      featureBins: FEATURE_BINS,
      sampledSignalsEveryNEpisodes: SAVE_SAMPLED_SIGNALS ?
        SAMPLE_ONE_IN_EPISODES : null,
      notes: [
        'Events are detected by past 60s drawdown, never by future minima.',
        'Rearm only after drawdown falls below 1.5 per mille.',
        'Candidate stages use first tick on/after the scheduled offset.',
        'Delay 0 fills on first tick strictly AFTER the signal.',
        '60s returns are measured from the delayed entry price.',
        'First-passage labels observe +3/-2 per mille from entry over 120s.',
        'No candle lookahead, order book, spread, borrowing or funding.',
        'Feature buckets are descriptive; no model training in this run.',
      ],
    }, null, 2) + '\n');
    console.log(`Finished: ${output}`);
  } finally {
    try { sink?.close(); } finally { db.close(); }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
