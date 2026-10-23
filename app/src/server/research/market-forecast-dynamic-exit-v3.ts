
// app/src/server/research/market-forecast-dynamic-exit-v3.ts
// Run from app: node --import tsx src/server/research/market-forecast-dynamic-exit-v3.ts
// Frozen v6 forecasts, next-tick fills, no order book and no refitting.

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
const OUTPUT_DIR = resolve('research-output/market-forecast-dynamic-exit-v3');
const FROZEN_TABLE_END_ISO = '2026-10-02T01:40:49.395Z';
const VALIDATION_FRACTION = 0.5;
const QUOTE_CURRENCIES = ['USD', 'USDT'];
const MARKET_NAMES: string[] = []; // Empty: all eligible markets.

// 3.0, 3.1, ..., 4.0. These are minimum absolute entry forecasts.
const ENTRY_THRESHOLDS = Array.from({ length: 11 }, (_, i) =>
  Number((3 + i * 0.1).toFixed(1)));
const EXIT_THRESHOLDS = [-2, -1.5, -1, -0.75, -0.5, 0];
const FEE_PER_SIDE_PERMILLE = 1;
const SLIPPAGE_PER_SIDE_PERMILLE = 0;
const MAX_SIGNAL_TO_FILL_MS = 10_000;
const MAX_TICK_GAP_MS = 60_000;
const DECISION_INTERVAL_MS = 1_000;

// The full trade journal may be large. Disable it if disk space is tight.
const SAVE_ALL_TRADES = true;
const FORECAST_HISTOGRAM_STEP = 0.1;

// The two exceptional frozen combined forecasts seen in v2.
// Match by exact underlying numeric value, with a tiny tolerance.
const TARGET_SIGNALS = [
  { name: '3.482658', value: 3.4826581683543187 },
  { name: '3.544130', value: 3.544129753241629 },
] as const;
const TARGET_TOLERANCE = 1e-9;
const FORWARD_HORIZONS_MS = [10_000, 30_000, 60_000] as const;
const MAX_FORWARD_LATENESS_MS = 10_000;
const INDEPENDENT_SAMPLE_SPACING_MS = 60_000;
const PROGRESS_INTERVAL_MS = 10_000;
const PROGRESS_TICKS_INTERVAL = 4096;

const TAUS_MS = [7_000, 15_000, 30_000, 60_000] as const;
const DIRECT_WARMUP_MS = 150_000;
const DERIVED_WARMUP_MS = 300_000;
const MIN_NEW_DATA_MS = 60 * 60_000;
const FROZEN_END = Date.parse(FROZEN_TABLE_END_ISO);

if (!Number.isFinite(FROZEN_END)) {
  throw new Error('Invalid FROZEN_TABLE_END_ISO');
}

type Tick = { t: number; p: number };
type Market = { id: number; name: string; money: string };
type Side = -1 | 1;
type Period = 'validation' | 'test';
type ForecastSource = '3ema' | '4ema' | 'combined';
type ForecastSample = {
  value: number | null;
  source: ForecastSource | null;
  cell: number;
  direct: number | null;
  derived: number | null;
  directCell: number;
  derivedCell: number;
  pairCell: number;
  speeds: number[];
  contrast: number | null;
  curvature: number | null;
};
type Combo = { entry: number; exit: number };
type CloseReason = 'signal' | 'gap' | 'end';
type Pending = {
  action: 'enter' | 'exit';
  side: Side;
  at: number;
  forecast: number;
};
type Position = {
  side: Side;
  enteredAt: number;
  entryPrice: number;
  entrySignalAt: number;
  entryForecast: number;
  mfe: number;
  mae: number;
};
type Runner = {
  position: Position | null;
  pending: Pending | null;
  equity: number[];
  peak: number[];
};
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
type MarketNet = { market: string; net: number; trades: number };

type ForecastDiagnostic = {
  samples: number;
  unavailable: number;
  min: number;
  max: number;
  positive3: number;
  positive35: number;
  positive4: number;
  negative3: number;
  negative35: number;
  negative4: number;
};

const COMBOS: Combo[] = ENTRY_THRESHOLDS.flatMap((entry) =>
  EXIT_THRESHOLDS.map((exit) => ({ entry, exit })));
const DIRECTIONS = ['all', 'long', 'short'] as const;
const PERIODS = ['validation', 'test'] as const;
const COST_PER_ROUNDTRIP = (() => {
  const fee = FEE_PER_SIDE_PERMILLE / 1000;
  const slip = SLIPPAGE_PER_SIDE_PERMILLE / 1000;
  if (fee < 0 || fee >= 1 || slip < 0 || slip >= 1) {
    throw new Error('Invalid transaction costs');
  }
  return 1000 * (Math.log1p(fee) - Math.log1p(-fee) +
    Math.log1p(slip) - Math.log1p(-slip));
})();

function stats(): Stats {
  return {
    trades: 0, wins: 0, gross: 0, net: 0, mfe: 0, mae: 0,
    durationMs: 0, signalCloses: 0, gapCloses: 0,
    endCloses: 0, maxMarketDrawdown: 0,
  };
}

function diagnostics(): ForecastDiagnostic {
  return {
    samples: 0, unavailable: 0, min: Infinity, max: -Infinity,
    positive3: 0, positive35: 0, positive4: 0,
    negative3: 0, negative35: 0, negative4: 0,
  };
}

function addStats(to: Stats, from: Stats): void {
  for (const key of [
    'trades', 'wins', 'gross', 'net', 'mfe', 'mae',
    'durationMs', 'signalCloses', 'gapCloses', 'endCloses',
  ] as const) to[key] += from[key];
  to.maxMarketDrawdown = Math.max(
    to.maxMarketDrawdown, from.maxMarketDrawdown);
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

function csv(values: (string | number | null)[]): string {
  return values.map((v) => {
    if (v === null || !Number.isFinite(v as number) && typeof v === 'number') {
      return '';
    }
    const text = String(v);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(',');
}

// Buffered synchronous writing: do not retain millions of trades in RAM.
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
    this.lines.length = 0;
    this.bytes = 0;
  }

  close(): void {
    try { this.flush(); } finally { closeSync(this.fd); }
  }
}

function bin(value: number, boundaries: readonly number[]): number {
  for (let i = 0; i < boundaries.length; i++) {
    if (value < boundaries[i]) return i;
  }
  return boundaries.length;
}

// This mirrors MarketForecastIndicator.predict() from the supplied src.
class Forecast {
  private readonly emas = new Float64Array(TAUS_MS.length);
  private first = NaN;
  private previous = NaN;

  update(t: number, price: number): ForecastSample {
    if (!Number.isFinite(price) || price <= 0) {
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

    if (age >= DERIVED_WARMUP_MS && Number.isFinite(v[3]) && v[3] !== 0) {
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
    let source: ForecastSource | null = direct === null
      ? derived === null ? null : '4ema' : '3ema';
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
      value, source,
      cell: pairCell !== -1 ? pairCell :
        direct !== null ? directCell : derivedCell,
      direct, derived, directCell, derivedCell, pairCell,
      speeds: v, contrast, curvature,
    };
  }
}

class ForecastDiagnostics {
  readonly totals: Record<Period, ForecastDiagnostic> = {
    validation: diagnostics(), test: diagnostics(),
  };
  private readonly hist = new Map<string, number>();
  private readonly values = new Map<string, {
    period: Period; source: ForecastSource;
    cell: number; value: number; count: number;
  }>();
  readonly marketCsv: string[] = [csv([
    'period', 'market', 'decisionSamples', 'noForecast',
    'minForecast', 'maxForecast',
    'positiveGE3', 'positiveGE3_5', 'positiveGE4',
    'negativeLEminus3', 'negativeLEminus3_5', 'negativeLEminus4',
  ])];

  observe(
    period: Period, market: ForecastDiagnostic,
    sample: ForecastSample,
  ): void {
    const value = sample.value;
    if (value === null || sample.source === null) {
      market.unavailable++;
      this.totals[period].unavailable++;
      return;
    }
    const overall = this.totals[period];
    for (const d of [market, overall]) {
      d.samples++;
      d.min = Math.min(d.min, value);
      d.max = Math.max(d.max, value);
      d.positive3 += Number(value >= 3);
      d.positive35 += Number(value >= 3.5);
      d.positive4 += Number(value >= 4);
      d.negative3 += Number(value <= -3);
      d.negative35 += Number(value <= -3.5);
      d.negative4 += Number(value <= -4);
    }
    // Zero-centred bins: [-0.1, 0), [0, 0.1), etc.
    const bucket = Math.floor(value / FORECAST_HISTOGRAM_STEP);
    const key = `${period}|${sample.source}|${bucket}`;
    this.hist.set(key, (this.hist.get(key) ?? 0) + 1);

    // Table values are frozen and discrete. Keep the exact cell and value.
    const id = `${period}|${sample.source}|${sample.cell}|${value}`;
    const record = this.values.get(id);
    if (record) record.count++;
    else this.values.set(id, {
      period, source: sample.source, cell: sample.cell,
      value, count: 1,
    });
  }

  finishMarket(
    period: Period, name: string, diagnostic: ForecastDiagnostic,
  ): void {
    this.marketCsv.push(csv([
      period, name, diagnostic.samples, diagnostic.unavailable,
      diagnostic.samples ? diagnostic.min : null,
      diagnostic.samples ? diagnostic.max : null,
      diagnostic.positive3, diagnostic.positive35, diagnostic.positive4,
      diagnostic.negative3, diagnostic.negative35, diagnostic.negative4,
    ]));
  }

  files(): Record<string, string> {
    const histogram = [csv([
      'period', 'source', 'fromInclusive', 'toExclusive', 'samples',
    ])];
    for (const [key, count] of [...this.hist].sort((a, b) => {
      const [ap, as, ai] = a[0].split('|');
      const [bp, bs, bi] = b[0].split('|');
      return ap.localeCompare(bp) || as.localeCompare(bs) ||
        Number(ai) - Number(bi);
    })) {
      const [period, source, bucket] = key.split('|');
      const from = Number(bucket) * FORECAST_HISTOGRAM_STEP;
      histogram.push(csv([
        period, source, Number(from.toFixed(10)),
        Number((from + FORECAST_HISTOGRAM_STEP).toFixed(10)), count,
      ]));
    }
    const exact = [csv([
      'period', 'source', 'tableCell', 'exactForecast', 'samples',
    ])];
    for (const value of [...this.values.values()].sort((a, b) =>
      a.period.localeCompare(b.period) || a.value - b.value ||
      b.count - a.count)) {
      exact.push(csv([
        value.period, value.source, value.cell,
        value.value, value.count,
      ]));
    }
    return {
      'forecast-histogram.csv': histogram.join('\n') + '\n',
      'forecast-values.csv': exact.join('\n') + '\n',
      'forecast-by-market.csv': this.marketCsv.join('\n') + '\n',
    };
  }
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
  const names = (await readdir(CACHE_DIR)).filter((name) =>
    /^market-research-cache_endedAt-.*\.sqlite$/.test(name)).sort();
  if (!names.length) throw new Error('No completed SQLite cache found');
  return resolve(CACHE_DIR, names[names.length - 1]);
}

// Forward-return diagnostic for the two strongest positive combined signals.
// All future returns use the first observation at or AFTER t + horizon,
// never a price known at signal time. No interpolation/look-ahead.
type HorizonAggregate = {
  n: number;
  sum: number;
  positive: number;
  spacedN: number;
  spacedSum: number;
  spacedPositive: number;
};

type SignalAggregate = {
  period: Period;
  group: string;
  count: number;
  markets: Set<string>;
  featureSums: number[];
  featureMins: number[];
  featureMaxs: number[];
  horizons: HorizonAggregate[];
  directCell: number;
  derivedCell: number;
  pairCell: number;
  direct: number;
  derived: number;
};

type SignalRecord = {
  period: Period;
  market: string;
  t: number;
  price: number;
  group: string;
  spaced: boolean;
  forecast: ForecastSample;
  aggregates: SignalAggregate[];
  returns: (number | null)[];
  lateness: (number | null)[];
  unresolved: number;
};

function signalAggregate(
  period: Period, group: string, sample: ForecastSample,
): SignalAggregate {
  return {
    period, group, count: 0, markets: new Set(),
    featureSums: Array(6).fill(0),
    featureMins: Array(6).fill(Infinity),
    featureMaxs: Array(6).fill(-Infinity),
    horizons: FORWARD_HORIZONS_MS.map(() => ({
      n: 0, sum: 0, positive: 0,
      spacedN: 0, spacedSum: 0, spacedPositive: 0,
    })),
    directCell: sample.directCell,
    derivedCell: sample.derivedCell,
    pairCell: sample.pairCell,
    direct: sample.direct ?? NaN,
    derived: sample.derived ?? NaN,
  };
}

function signalFeatures(sample: ForecastSample): number[] {
  return [
    ...sample.speeds,
    sample.contrast ?? NaN,
    sample.curvature ?? NaN,
  ];
}

function forwardColumns(agg: HorizonAggregate): number[] {
  return [
    agg.n, agg.n ? agg.sum / agg.n : NaN,
    agg.n ? agg.positive / agg.n : NaN,
    agg.spacedN,
    agg.spacedN ? agg.spacedSum / agg.spacedN : NaN,
    agg.spacedN ? agg.spacedPositive / agg.spacedN : NaN,
  ];
}

class SignalStudy {
  private queues: SignalRecord[][] = FORWARD_HORIZONS_MS.map(() => []);
  private heads = FORWARD_HORIZONS_MS.map(() => 0);
  private lastSpaced = new Map<string, number>();
  private readonly overall = new Map<string, SignalAggregate>();
  private readonly byMarket = new Map<string, SignalAggregate>();
  private readonly byComponents = new Map<string, SignalAggregate>();
  private selected = 0;

  constructor(private readonly sink: CsvSink) {}

  startMarket(): void {
    this.flushUnresolved();
    this.lastSpaced.clear();
  }

  finishPeriod(): void {
    // Do not use future test prices for validation signals.
    this.flushUnresolved();
    this.lastSpaced.clear();
  }

  private getAggregate(
    map: Map<string, SignalAggregate>, key: string,
    period: Period, group: string, sample: ForecastSample,
  ): SignalAggregate {
    let aggregate = map.get(key);
    if (!aggregate) {
      aggregate = signalAggregate(period, group, sample);
      map.set(key, aggregate);
    }
    return aggregate;
  }

  private resolve(
    record: SignalRecord, horizonIndex: number,
    price: number | null, lateness: number | null,
  ): void {
    const value = price === null ? null :
      1000 * Math.log(price / record.price);
    record.returns[horizonIndex] = value;
    record.lateness[horizonIndex] = lateness;
    if (value !== null) {
      for (const bucket of record.aggregates) {
        const h = bucket.horizons[horizonIndex];
        h.n++;
        h.sum += value;
        h.positive += Number(value > 0);
        if (record.spaced) {
          h.spacedN++;
          h.spacedSum += value;
          h.spacedPositive += Number(value > 0);
        }
      }
    }
    record.unresolved--;
    if (record.unresolved === 0) this.sink.add([
      record.period, record.market, record.group,
      record.t, record.price, record.spaced ? 1 : 0,
      record.forecast.value, record.forecast.direct,
      record.forecast.derived, record.forecast.directCell,
      record.forecast.derivedCell, record.forecast.pairCell,
      ...signalFeatures(record.forecast),
      ...record.returns, ...record.lateness,
    ]);
  }

  private flushUnresolved(): void {
    for (let i = 0; i < this.queues.length; i++) {
      const queue = this.queues[i];
      for (let j = this.heads[i]; j < queue.length; j++) {
        this.resolve(queue[j], i, null, null);
      }
      this.queues[i] = [];
      this.heads[i] = 0;
    }
  }

  onTick(
    tick: Tick, period: Period, market: string,
    sample: ForecastSample, decision: boolean,
  ): void {
    // Resolve earlier signals even when this is not a decision tick.
    for (let i = 0; i < FORWARD_HORIZONS_MS.length; i++) {
      const queue = this.queues[i];
      let head = this.heads[i];
      while (head < queue.length &&
        queue[head].t + FORWARD_HORIZONS_MS[i] <= tick.t) {
        const record = queue[head++];
        const lateness = tick.t - record.t - FORWARD_HORIZONS_MS[i];
        this.resolve(record, i,
          lateness <= MAX_FORWARD_LATENESS_MS ? tick.p : null,
          lateness <= MAX_FORWARD_LATENESS_MS ? lateness : null);
      }
      if (head >= 4096 && head * 2 >= queue.length) {
        queue.splice(0, head);
        head = 0;
      }
      this.heads[i] = head;
    }

    if (!decision || sample.source !== 'combined' ||
      sample.value === null) return;
    const group = TARGET_SIGNALS.find((target) =>
      Math.abs(target.value - sample.value!) <= TARGET_TOLERANCE);
    if (!group) return;
    const spacedKey = `${period}|${group.name}`;
    const lastSpaced = this.lastSpaced.get(spacedKey) ?? -Infinity;
    const spaced = tick.t - lastSpaced >= INDEPENDENT_SAMPLE_SPACING_MS;
    if (spaced) this.lastSpaced.set(spacedKey, tick.t);
    const componentKey = [
      period, group.name, sample.directCell, sample.derivedCell,
      sample.pairCell, sample.direct, sample.derived,
    ].join('|');
    const buckets = [
      this.getAggregate(this.overall, spacedKey,
        period, group.name, sample),
      this.getAggregate(this.byMarket, `${spacedKey}|${market}`,
        period, group.name, sample),
      this.getAggregate(this.byComponents, componentKey,
        period, group.name, sample),
    ];
    const features = signalFeatures(sample);
    for (const bucket of buckets) {
      bucket.count++;
      bucket.markets.add(market);
      for (let j = 0; j < features.length; j++) {
        bucket.featureSums[j] += features[j];
        bucket.featureMins[j] = Math.min(bucket.featureMins[j], features[j]);
        bucket.featureMaxs[j] = Math.max(bucket.featureMaxs[j], features[j]);
      }
    }
    const record: SignalRecord = {
      period, market, t: tick.t, price: tick.p,
      group: group.name, spaced, forecast: sample,
      aggregates: buckets,
      returns: FORWARD_HORIZONS_MS.map(() => null),
      lateness: FORWARD_HORIZONS_MS.map(() => null),
      unresolved: FORWARD_HORIZONS_MS.length,
    };
    for (const queue of this.queues) queue.push(record);
    this.selected++;
  }

  get selectedCount(): number { return this.selected; }

  private aggregatesCsv(
    buckets: Iterable<SignalAggregate>, includeComponents: boolean,
  ): string {
    const rows = [csv([
      'period', 'group', 'samples', 'markets',
      ...(includeComponents ? [
        'directCell', 'derivedCell', 'pairCell', 'direct',
        'derived', 'pairCorrection',
      ] : []),
      'meanV7', 'meanV15', 'meanV30', 'meanV60',
      'meanContrast', 'meanCurvature',
      'minV7', 'minV15', 'minV30', 'minV60',
      'minContrast', 'minCurvature',
      'maxV7', 'maxV15', 'maxV30', 'maxV60',
      'maxContrast', 'maxCurvature',
      ...FORWARD_HORIZONS_MS.flatMap((h) => [
        `n${h / 1000}s`, `mean${h / 1000}s`,
        `positiveRate${h / 1000}s`,
        `spacedN${h / 1000}s`, `spacedMean${h / 1000}s`,
        `spacedPositiveRate${h / 1000}s`,
      ]),
    ])];
    for (const bucket of buckets) {
      rows.push(csv([
        bucket.period, bucket.group,
        bucket.count, bucket.markets.size,
        ...(includeComponents ? [
          bucket.directCell, bucket.derivedCell, bucket.pairCell,
          bucket.direct, bucket.derived,
          MARKET_FORECAST_COMBINED_CORRECTION[bucket.pairCell],
        ] : []),
        ...bucket.featureSums.map((sum) => sum / bucket.count),
        ...bucket.featureMins, ...bucket.featureMaxs,
        ...bucket.horizons.flatMap(forwardColumns),
      ]));
    }
    return rows.join('\n') + '\n';
  }

  files(): Record<string, string> {
    const summary = this.aggregatesCsv(this.overall.values(), false);
    const components = this.aggregatesCsv(
      this.byComponents.values(), true);
    const marketRows = [csv([
      'period', 'group', 'market', 'samples',
      ...FORWARD_HORIZONS_MS.flatMap((h) => [
        `n${h / 1000}s`, `mean${h / 1000}s`,
        `positiveRate${h / 1000}s`, `spacedN${h / 1000}s`,
        `spacedMean${h / 1000}s`,
        `spacedPositiveRate${h / 1000}s`,
      ]),
    ])];
    for (const [key, bucket] of this.byMarket) {
      const market = key.split('|').slice(2).join('|');
      marketRows.push(csv([
        bucket.period, bucket.group, market, bucket.count,
        ...bucket.horizons.flatMap(forwardColumns),
      ]));
    }
    return {
      'signal-summary.csv': summary,
      'signal-components.csv': components,
      'signal-by-market.csv': marketRows.join('\n') + '\n',
    };
  }
}

class MarketSimulation {
  private readonly forecast = new Forecast();
  private readonly runners: Runner[] = COMBOS.map(() => ({
    position: null, pending: null,
    equity: [0, 0, 0], peak: [0, 0, 0],
  }));
  private readonly ownStats = COMBOS.map(() =>
    [stats(), stats(), stats()]);
  private period: Period | null = null;
  private lastTick: Tick | null = null;
  private lastDecision = -Infinity;
  private marketDiagnostic = diagnostics();

  constructor(
    private readonly market: Market,
    private readonly splitAt: number,
    private readonly totals: Record<Period, Stats[][]>,
    private readonly marketContributions: Record<Period, MarketNet[][][]>,
    private readonly byMarketCsv: string[],
    private readonly forecastDiagnostics: ForecastDiagnostics,
    private readonly signals: SignalStudy,
    private readonly trades: CsvSink | null,
  ) {}

  run(db: DatabaseSync): void {
    this.signals.startMarket();
    let ticks = 0;
    let lastProgressAt = Date.now();
    console.log(`[market] ${this.market.name}: started`);
    for (const tick of readTicks(db, this.market.id)) {
      ticks++;
      if (ticks % PROGRESS_TICKS_INTERVAL === 0 &&
        Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        console.log(`[market] ${this.market.name}: ` +
          `${ticks.toLocaleString()} ticks, ` +
          `through ${new Date(tick.t).toISOString()}`);
        lastProgressAt = Date.now();
      }
      const sample = this.forecast.update(tick.t, tick.p);
      if (tick.t <= FROZEN_END) continue;
      const period: Period = tick.t < this.splitAt
        ? 'validation' : 'test';
      if (this.period !== period) {
        if (this.period && this.lastTick) this.finishPeriod();
        this.signals.finishPeriod();
        this.period = period;
        this.lastTick = null;
        this.lastDecision = -Infinity;
        this.marketDiagnostic = diagnostics();
      }
      const previous = this.lastTick;
      const gap = previous !== null &&
        tick.t - previous.t > MAX_TICK_GAP_MS;
      const decide = tick.t - this.lastDecision >= DECISION_INTERVAL_MS;
      if (decide) {
        this.lastDecision = tick.t;
        this.forecastDiagnostics.observe(
          period, this.marketDiagnostic, sample);
      }
      this.signals.onTick(tick, period, this.market.name, sample, decide);

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
                entryPrice: tick.p, entrySignalAt: pending.at,
                entryForecast: pending.forecast, mfe: 0, mae: 0,
              };
            }
          } else if (runner.position) {
            this.close(i, tick, 'signal', pending);
          }
        }
        const position = runner.position;
        if (position) {
          const movement = 1000 * position.side *
            Math.log(tick.p / position.entryPrice);
          position.mfe = Math.max(position.mfe, movement);
          position.mae = Math.min(position.mae, movement);
        }
        if (!decide || sample.value === null || runner.pending) continue;
        if (position) {
          if (position.side * sample.value <= COMBOS[i].exit) {
            runner.pending = {
              action: 'exit', side: position.side,
              at: tick.t, forecast: sample.value,
            };
          }
        } else if (Math.abs(sample.value) >= COMBOS[i].entry) {
          runner.pending = {
            action: 'enter', side: sample.value > 0 ? 1 : -1,
            at: tick.t, forecast: sample.value,
          };
        }
      }
      this.lastTick = tick;
    }
    if (this.period && this.lastTick) this.finishPeriod();
    this.signals.finishPeriod();
    console.log(`[market] ${this.market.name}: done, ` +
      `${ticks.toLocaleString()} ticks`);
  }

  private close(
    i: number, tick: Tick, reason: CloseReason,
    exit: Pending | null = null,
  ): void {
    const runner = this.runners[i];
    const position = runner.position;
    if (!position || !this.period) return;
    const gross = 1000 * position.side *
      Math.log(tick.p / position.entryPrice);
    const net = gross - COST_PER_ROUNDTRIP;
    for (const d of [0, position.side === 1 ? 1 : 2]) {
      runner.equity[d] += net;
      runner.peak[d] = Math.max(runner.peak[d], runner.equity[d]);
      const drawdown = runner.peak[d] - runner.equity[d];
      const result = this.ownStats[i][d];
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
    if (this.trades) this.trades.add([
      this.period, this.market.name, this.market.money,
      COMBOS[i].entry, COMBOS[i].exit,
      position.side === 1 ? 'long' : 'short',
      position.entrySignalAt, position.entryForecast,
      position.enteredAt, position.entryPrice,
      exit?.at ?? null, exit?.forecast ?? null,
      tick.t, tick.p, (tick.t - position.enteredAt) / 1000,
      gross, net, position.mfe, position.mae, reason,
    ]);
    runner.position = null;
  }

  private finishPeriod(): void {
    if (!this.period || !this.lastTick) return;
    const period = this.period;
    for (let i = 0; i < COMBOS.length; i++) {
      const runner = this.runners[i];
      if (runner.position) this.close(i, this.lastTick, 'end');
      runner.pending = null;
      runner.equity.fill(0);
      runner.peak.fill(0);
      for (let d = 0; d < 3; d++) {
        const result = this.ownStats[i][d];
        addStats(this.totals[period][i][d], result);
        if (result.trades) {
          this.marketContributions[period][i][d].push({
            market: this.market.name,
            net: result.net, trades: result.trades,
          });
          this.byMarketCsv.push(csv([
            period, this.market.name, this.market.money,
            COMBOS[i].entry, COMBOS[i].exit,
            DIRECTIONS[d], ...statsValues(result),
          ]));
        }
        this.ownStats[i][d] = stats();
      }
    }
    this.forecastDiagnostics.finishMarket(
      period, this.market.name, this.marketDiagnostic);
  }
}

function concentrationCsv(
  totals: Record<Period, Stats[][]>,
  contributions: Record<Period, MarketNet[][][]>,
): string {
  const rows = [csv([
    'period', 'entryThreshold', 'exitThreshold', 'direction',
    'marketsWithTrades', 'profitableMarkets', 'netLogPermilleSum',
    'netExcludingTop1', 'netExcludingTop2', 'netExcludingTop5',
    'top1Market', 'top1Net', 'top2Market', 'top2Net',
  ])];
  for (const period of PERIODS) {
    for (let i = 0; i < COMBOS.length; i++) {
      for (let d = 0; d < 3; d++) {
        const markets = [...contributions[period][i][d]].sort(
          (a, b) => b.net - a.net);
        const net = totals[period][i][d].net;
        const top = (n: number) => markets.slice(0, n).reduce(
          (sum, market) => sum + market.net, 0);
        rows.push(csv([
          period, COMBOS[i].entry, COMBOS[i].exit, DIRECTIONS[d],
          markets.length, markets.filter((m) => m.net > 0).length,
          net, net - top(1), net - top(2), net - top(5),
          markets[0]?.market ?? '', markets[0]?.net ?? null,
          markets[1]?.market ?? '', markets[1]?.net ?? null,
        ]));
      }
    }
  }
  return rows.join('\n') + '\n';
}

async function main(): Promise<void> {
  console.log('[startup] Selecting finished SQLite cache...');
  const cache = await newestCache();
  console.log(`[startup] Opening ${cache}`);
  const db = new DatabaseSync(cache, { readOnly: true });
  let tradeSink: CsvSink | null = null;
  let signalSink: CsvSink | null = null;
  try {
    const schema = db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (schema.user_version !== 1) {
      throw new Error(`Expected SQLite schema v1, got ${schema.user_version}`);
    }
    // Important: MAX(received_at) on observations scans the huge
    // WITHOUT ROWID table because the primary key starts with market_id.
    // market_cache_stats has only one row per market.
    console.log('[startup] Reading cache metadata (no full tick scan)...');
    const range = db.prepare(`
      SELECT MAX(last_received_at) AS last FROM market_cache_stats
    `).get() as { last: number | null };
    if (range.last === null || range.last - FROZEN_END < MIN_NEW_DATA_MS) {
      throw new Error('Not enough data after the frozen table cutoff');
    }
    const splitAt = Math.floor(FROZEN_END +
      VALIDATION_FRACTION * (range.last - FROZEN_END));
    console.log('[startup] Selecting USD/USDT spot markets...');
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
    const contributions: Record<Period, MarketNet[][][]> = {
      validation: COMBOS.map(() => [[], [], []]),
      test: COMBOS.map(() => [[], [], []]),
    };
    const byMarket = [csv([
      'period', 'market', 'quote', 'entryThreshold',
      'exitThreshold', 'direction', ...STATS_HEADER,
    ])];
    const diagnostic = new ForecastDiagnostics();
    console.log('[startup] Creating result directory and CSV sinks...');
    await mkdir(OUTPUT_DIR, { recursive: true });
    const output = await mkdtemp(resolve(OUTPUT_DIR, 'run-'));
    signalSink = new CsvSink(resolve(output, 'signal-samples.csv'), [
      'period', 'market', 'group', 'receivedAt', 'price',
      'spaced60s', 'combinedForecast', 'directForecast',
      'derivedForecast', 'directCell', 'derivedCell', 'pairCell',
      'v7', 'v15', 'v30', 'v60', 'contrast', 'curvature',
      'return10s', 'return30s', 'return60s',
      'lateness10sMs', 'lateness30sMs', 'lateness60sMs',
    ]);
    const signals = new SignalStudy(signalSink);
    if (SAVE_ALL_TRADES) {
      tradeSink = new CsvSink(resolve(output, 'trades.csv'), [
        'period', 'market', 'quote', 'entryThreshold',
        'exitThreshold', 'direction', 'entrySignalAt',
        'entrySignalForecast', 'enteredAt', 'entryPrice',
        'exitSignalAt', 'exitSignalForecast', 'exitedAt',
        'exitPrice', 'durationSeconds', 'grossLogPermille',
        'netLogPermille', 'mfePermille', 'maePermille',
        'closeReason',
      ]);
    }
    console.log(`Cache: ${cache}`);
    console.log(`Markets: ${markets.length}; combos: ${COMBOS.length}`);
    console.log(`Validation: ${FROZEN_TABLE_END_ISO} to ` +
      `${new Date(splitAt).toISOString()}`);
    console.log(`Test: ${new Date(splitAt).toISOString()} to ` +
      `${new Date(range.last).toISOString()}`);
    console.log(`Log round-trip cost: ${COST_PER_ROUNDTRIP}‰`);
    console.log(`Output: ${output}`);

    for (let i = 0; i < markets.length; i++) {
      new MarketSimulation(
        markets[i], splitAt, totals, contributions, byMarket,
        diagnostic, signals, tradeSink,
      ).run(db);
      console.log(`[progress] ${i + 1}/${markets.length} markets ` +
        `(${(100 * (i + 1) / markets.length).toFixed(1)}%), ` +
        `target signals=${signals.selectedCount.toLocaleString()}`);
    }
    const summary = [csv([
      'period', 'entryThreshold', 'exitThreshold',
      'direction', ...STATS_HEADER,
    ])];
    for (const period of PERIODS) {
      for (let i = 0; i < COMBOS.length; i++) {
        for (let d = 0; d < 3; d++) {
          summary.push(csv([
            period, COMBOS[i].entry, COMBOS[i].exit,
            DIRECTIONS[d], ...statsValues(totals[period][i][d]),
          ]));
        }
      }
    }
    await writeFile(resolve(output, 'summary.csv'),
      summary.join('\n') + '\n');
    await writeFile(resolve(output, 'by-market.csv'),
      byMarket.join('\n') + '\n');
    await writeFile(resolve(output, 'concentration.csv'),
      concentrationCsv(totals, contributions));
    for (const [name, content] of Object.entries(diagnostic.files())) {
      await writeFile(resolve(output, name), content);
    }
    for (const [name, content] of Object.entries(signals.files())) {
      await writeFile(resolve(output, name), content);
    }
    signalSink.close();
    signalSink = null;
    await writeFile(resolve(output, 'run.json'), JSON.stringify({
      cache: basename(cache), frozenTableEnd: FROZEN_TABLE_END_ISO,
      splitAt: new Date(splitAt).toISOString(),
      lastTick: new Date(range.last).toISOString(),
      markets: markets.length, quoteCurrencies: QUOTE_CURRENCIES,
      entryThresholds: ENTRY_THRESHOLDS,
      exitThresholds: EXIT_THRESHOLDS,
      combos: COMBOS.length, feePerSidePermille: FEE_PER_SIDE_PERMILLE,
      slippagePerSidePermille: SLIPPAGE_PER_SIDE_PERMILLE,
      roundTripLogCostPermille: COST_PER_ROUNDTRIP,
      maxSignalToFillMs: MAX_SIGNAL_TO_FILL_MS,
      maxTickGapMs: MAX_TICK_GAP_MS,
      decisionIntervalMs: DECISION_INTERVAL_MS,
      histogramStep: FORECAST_HISTOGRAM_STEP,
      diagnosticPolicy: 'forecast sampled at strategy decision ticks',
      nextTickExecution: true,
      priceModel: 'last trade price; no spread/order book',
      shortModel: 'ideal short; no borrow or funding',
      splitPolicy: 'close positions at each period end',
      tradesSaved: SAVE_ALL_TRADES,
      forecastValidation: 'matches v6 MarketForecastIndicator.predict()',
      forecastTotals: diagnostic.totals,
      targetSignals: TARGET_SIGNALS,
      selectedTargetSamples: signals.selectedCount,
      forwardHorizonsMs: FORWARD_HORIZONS_MS,
      maxForwardLatenessMs: MAX_FORWARD_LATENESS_MS,
      independentSampleSpacingMs: INDEPENDENT_SAMPLE_SPACING_MS,
      forwardPolicy: 'first tick at or after horizon; no interpolation',
      independentSamplePolicy: 'at least 60s between signals in each market/group',
    }, null, 2) + '\n');
    console.log(`Finished: ${output}`);
  } finally {
    try { tradeSink?.close(); }
    finally { try { signalSink?.close(); } finally { db.close(); } }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
