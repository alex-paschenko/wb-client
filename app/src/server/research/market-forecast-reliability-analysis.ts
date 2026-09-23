// app/src/server/research/market-forecast-reliability-analysis.ts
// V4: observed-price triangle diagnostics. No forecast training or filtering.
// Run from app: node --import tsx src/server/research/market-forecast-reliability-analysis.ts
// Self-test: append --self-test (no PostgreSQL connection required).
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MarketCandle } from '../../shared/types/data-types.js';
import type { LazyArray } from '../../shared/utilities/lazy-array.js';

const BASE_CURRENCY = 'USDT';
const HORIZONS = [10_000, 30_000, 60_000, 120_000, 300_000];
const AGE_LIMITS = [1_000, 2_000, 5_000, 10_000];
const SKEW_LIMITS: (number | null)[] = [null, 250, 1_000];
const CHANGE_LIMITS: (number | null)[] = [null, 10_000, 30_000, 60_000];
const STEP = integer('MF_STEP_MS', 10_000, 1, 300_000);
const MAX_BLOB = integer('MF_MAX_SNAPSHOT_MB', 64, 1, 1024) * 1024 ** 2;
const REQUESTED_START = dateEnv('MF_START_AT');
const REQUESTED_END = dateEnv('MF_END_AT');
const OUTPUT = resolve('research-output/market-forecast-reliability-v4');
const PAGE = 2048;
// Fixed histogram: exact zero, logarithmic bins, explicit overflow.
const HIST_MIN = 0.000001;
const HIST_RATIO = 1.1;
const HIST_BINS = 256;

type Market = { id: number; name: string; stock: string; money: string };
type Tick = { t: number; p: number };
type Seen = Tick & { changedAt: number | null };
type Edge = { market: Market; from: string; to: string; sign: number };
type Triangle = { a: Edge; b: Edge; direct: Edge; id: string };
type Profile = { id: string; age: number; skew: number | null;
  change: number | null };
const PROFILES: Profile[] = AGE_LIMITS.flatMap((age) =>
  SKEW_LIMITS.flatMap((skew) => CHANGE_LIMITS.map((change) => ({
    id: `age:${age};skew:${skew ?? 'any'};change:${change ?? 'any'}`,
    age, skew, change,
  }))),
);

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

// Scan from the first archived tick so change age is not reset at a seed.
// Only six bounded pages are retained while evaluating one triangle/horizon.
class Reader {
  private page: Tick[] = [];
  private index = 0;
  private last = -Number.MAX_SAFE_INTEGER;
  private current: Seen | null = null;
  private exhausted = false;
  private previousRequest = -Infinity;
  private readonly query;

  constructor(db: DatabaseSync, private readonly market: number) {
    this.query = db.prepare(`
      SELECT t, p FROM observations
      WHERE market = ? AND t > ? ORDER BY t LIMIT ${PAGE}
    `);
  }

  at(time: number): Seen | null {
    if (time < this.previousRequest) throw new Error('Nonmonotonic reader');
    this.previousRequest = time;
    for (;;) {
      if (this.index === this.page.length) {
        if (this.exhausted) break;
        this.page = this.query.all(this.market, this.last) as Tick[];
        this.index = 0;
        if (!this.page.length) { this.exhausted = true; break; }
        this.last = this.page[this.page.length - 1].t;
      }
      const next = this.page[this.index];
      if (next.t > time) break;
      const changedAt = this.current && this.current.p !== next.p
        ? next.t : this.current?.changedAt ?? null;
      this.current = { ...next, changedAt };
      this.index++;
    }
    return this.current;
  }
}

function edgeName(e: Edge) {
  return `${e.sign > 0 ? '+' : '-'}${e.market.name}`;
}

function* triangles(markets: Market[]): Generator<Triangle> {
  const graph = new Map<string, Edge[]>();
  for (const market of markets) {
    if (market.stock === market.money) continue;
    for (const e of [
      { market, from: market.stock, to: market.money, sign: 1 },
      { market, from: market.money, to: market.stock, sign: -1 },
    ]) {
      const edges = graph.get(e.from) ?? [];
      edges.push(e);
      graph.set(e.from, edges);
    }
  }
  for (const currency of [...graph.keys()].sort()) {
    if (currency === BASE_CURRENCY) continue;
    const outgoing = graph.get(currency)!;
    for (const direct of outgoing.filter((e) => e.to === BASE_CURRENCY)) {
      for (const a of outgoing) {
        if (a.to === BASE_CURRENCY) continue;
        for (const b of graph.get(a.to) ?? []) {
          if (b.to !== BASE_CURRENCY) continue;
          yield { a, b, direct, id:
            `${edgeName(a)} -> ${edgeName(b)} | ${edgeName(direct)}` };
        }
      }
    }
  }
}

type Sample = ReturnType<typeof measure>;
function measure(edges: Edge[], now: Seen[], then: Seen[], t: number,
  horizon: number) {
  const signedLog = (x: Seen, i: number) =>
    edges[i].sign * 1000 * Math.log(x.p);
  const basis = (xs: Seen[]) =>
    signedLog(xs[0], 0) + signedLog(xs[1], 1) - signedLog(xs[2], 2);
  const returns = now.map((x, i) =>
    edges[i].sign * 1000 * (Math.log(then[i].p) - Math.log(x.p)));
  const direct = returns[2];
  const synthetic = returns[0] + returns[1];
  const ages = now.map((x) => t - x.t)
    .concat(then.map((x) => t + horizon - x.t));
  const spread = (xs: Seen[]) =>
    Math.max(...xs.map((x) => x.t)) - Math.min(...xs.map((x) => x.t));
  const changeAges = now.map((x) =>
    x.changedAt === null ? null : t - x.changedAt).concat(then.map((x) =>
    x.changedAt === null ? null : t + horizon - x.changedAt));
  return {
    error: synthetic - direct, direct, synthetic,
    basis: basis(now), futureBasis: basis(then),
    age: Math.max(...ages), skew: Math.max(spread(now), spread(then)),
    changeAge: changeAges.some((x) => x === null)
      ? null : Math.max(...changeAges as number[]),
  };
}

function accepts(p: Profile, x: Sample) {
  return x.age <= p.age && (p.skew === null || x.skew <= p.skew) &&
    (p.change === null || (x.changeAge !== null && x.changeAge <= p.change));
}

function histIndex(v: number) {
  if (v === 0) return 0;
  return Math.min(HIST_BINS - 1, Math.max(1,
    1 + Math.ceil(Math.log(v / HIST_MIN) / Math.log(HIST_RATIO))));
}

function quantile(s: Stats, fraction: number): number | null {
  if (!s.n) return null;
  const target = Math.ceil(s.n * fraction);
  let count = 0;
  for (let i = 0; i < HIST_BINS; i++) {
    count += s.hist[i];
    if (count >= target) {
      if (i === HIST_BINS - 1) return null;
      return i === 0 ? 0 : HIST_MIN * HIST_RATIO ** (i - 1);
    }
  }
  throw new Error('Histogram count mismatch');
}

function newStats() {
  return { n: 0, mean: 0, m2: 0, abs: 0, max: 0,
    direct2: 0, synthetic2: 0, direct: 0, synthetic: 0,
    meanBasis: 0, basisM2: 0, absBasis: 0,
    age: 0, skew: 0, knownChange: 0, changeAge: 0,
    flatDirect: 0, flatSynthetic: 0, sameDirection: 0, bothMoving: 0,
    hist: new Float64Array(HIST_BINS) };
}
type Stats = ReturnType<typeof newStats>;

function add(s: Stats, x: Sample) {
  s.n++;
  const delta = x.error - s.mean;
  s.mean += delta / s.n;
  s.m2 += delta * (x.error - s.mean);
  const db = x.basis - s.meanBasis;
  s.meanBasis += db / s.n;
  s.basisM2 += db * (x.basis - s.meanBasis);
  s.absBasis += Math.abs(x.basis);
  s.abs += Math.abs(x.error);
  s.max = Math.max(s.max, Math.abs(x.error));
  s.hist[histIndex(Math.abs(x.error))]++;
  s.direct += x.direct;
  s.synthetic += x.synthetic;
  s.direct2 += x.direct ** 2;
  s.synthetic2 += x.synthetic ** 2;
  s.age += x.age;
  s.skew += x.skew;
  if (x.changeAge !== null) { s.knownChange++; s.changeAge += x.changeAge; }
  if (x.direct === 0) s.flatDirect++;
  if (x.synthetic === 0) s.flatSynthetic++;
  if (x.direct !== 0 && x.synthetic !== 0) s.bothMoving++;
  if (x.direct * x.synthetic > 0) s.sameDirection++;
}

function merge(a: Stats, b: Stats) {
  if (!b.n) return;
  const n = a.n + b.n;
  const d = b.mean - a.mean;
  a.m2 += b.m2 + d * d * a.n * b.n / n;
  a.mean += d * b.n / n;
  const db = b.meanBasis - a.meanBasis;
  a.basisM2 += b.basisM2 + db * db * a.n * b.n / n;
  a.meanBasis += db * b.n / n;
  a.n = n;
  for (const key of ['abs', 'direct2', 'synthetic2', 'direct', 'synthetic',
    'absBasis', 'age', 'skew', 'knownChange', 'changeAge', 'flatDirect',
    'flatSynthetic', 'sameDirection', 'bothMoving'] as const) a[key] += b[key];
  a.max = Math.max(a.max, b.max);
  for (let i = 0; i < HIST_BINS; i++) a.hist[i] += b.hist[i];
}

const HEADERS = [
  'scope', 'triangle', 'currency', 'via', 'directMarket', 'horizonMs',
  'profile', 'maxTickAgeMs', 'maxTickSkewMs', 'maxChangeAgeMs',
  'candidates', 'missingEndpoint', 'completeEndpoints', 'samples',
  'coverage', 'coverageOfComplete', 'contributingTriangles',
  'meanDeltaBasis', 'stdDeltaBasis', 'maeDeltaBasis', 'rmseDeltaBasis',
  'p50AbsDeltaUpper', 'p90AbsDeltaUpper', 'p95AbsDeltaUpper',
  'p99AbsDeltaUpper', 'histogramOverflow', 'maxAbsDeltaBasis',
  'meanBasisAtOrigin', 'stdBasisAtOrigin', 'meanAbsBasisAtOrigin',
  'meanDirectReturn', 'meanSyntheticReturn', 'rmsDirectReturn',
  'rmsSyntheticReturn', 'relativeRmse', 'flatDirect', 'flatSynthetic',
  'bothMoving', 'sameDirection', 'directionAgreementWhenBothMove',
  'meanMaxTickAgeMs', 'meanMaxTickSkewMs', 'knownChangeSamples',
  'meanMaxChangeAgeMs',
];

async function report(csv: Csv, triangle: Triangle | null, h: number,
  p: Profile, s: Stats, candidates: number, missing: number,
  contributors: number) {
  const n = s.n;
  const avg = (v: number) => n ? v / n : null;
  const rmse = n ? Math.sqrt(s.m2 / n + s.mean ** 2) : null;
  const directRms = n ? Math.sqrt(s.direct2 / n) : null;
  await csv.row([
    triangle ? 'triangle' : 'pooled', triangle?.id ?? '*',
    triangle?.a.from ?? '*', triangle?.a.to ?? '*',
    triangle?.direct.market.name ?? '*', h, p.id, p.age, p.skew, p.change,
    candidates, missing, candidates - missing, n,
    candidates ? n / candidates : null,
    candidates > missing ? n / (candidates - missing) : null, contributors,
    n ? s.mean : null, n ? Math.sqrt(s.m2 / n) : null, avg(s.abs), rmse,
    ...[0.5, 0.9, 0.95, 0.99].map((q) => quantile(s, q)),
    s.hist[HIST_BINS - 1], n ? s.max : null,
    n ? s.meanBasis : null, n ? Math.sqrt(s.basisM2 / n) : null,
    avg(s.absBasis), avg(s.direct), avg(s.synthetic), directRms,
    n ? Math.sqrt(s.synthetic2 / n) : null,
    directRms && rmse !== null ? rmse / directRms : null,
    s.flatDirect, s.flatSynthetic, s.bothMoving, s.sameDirection,
    s.bothMoving ? s.sameDirection / s.bothMoving : null,
    avg(s.age), avg(s.skew), s.knownChange,
    s.knownChange ? s.changeAge / s.knownChange : null,
  ]);
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

async function main() {
  // Load project services only for a real run, not for self-tests.
  const { CANDLE_NAME } = await import('../../shared/constants/storage-entities.js');
  const { Storage } = await import('../../shared/services/storage.js');
  const { decodeEntireBinary } = await import(
    '../../shared/utilities/codecs/entire-binary-codec.js');
  const { q } = await import('../db/client.js');
  const { entityManager } = await import('../services/entity-manager.js');
  const { serverGlobalStateService } = await import('../services/global-state.js');
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
        market INTEGER NOT NULL, t INTEGER NOT NULL, p REAL NOT NULL,
        PRIMARY KEY (market, t)
      ) WITHOUT ROWID;
    `);
    const insert = db.prepare(`
      INSERT INTO observations VALUES (?, ?, ?)
      ON CONFLICT (market, t) DO UPDATE SET p = excluded.p
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
            for (let start = storage.levelBoundaries[0];
              start < storage.size; start += PAGE) {
              db.exec('BEGIN');
              try {
                for (let i = start; i < Math.min(start + PAGE, storage.size); i++) {
                  const candle = candles.get(i);
                  if (!Number.isSafeInteger(candle.receivedAt) ||
                    !Number.isFinite(candle.price) || candle.price <= 0) {
                    rejectedRows++;
                    continue;
                  }
                  insert.run(id, candle.receivedAt, candle.price);
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
    const start = REQUESTED_START ?? range.first;
    const end = REQUESTED_END ?? range.last;
    if (start < range.first || end > range.last || start >= end) {
      throw new Error('MF_START_AT/MF_END_AT must define a range inside the archive');
    }
    if (end - start < Math.min(...HORIZONS)) {
      throw new Error('Selected interval is shorter than the shortest horizon');
    }
    const gridStart = Math.ceil(start / STEP) * STEP;
    const metrics = await Csv.create(resolve(directory, 'triangles.csv'), HEADERS);
    files.push(metrics);
    const summary = await Csv.create(resolve(directory, 'summary.csv'), HEADERS);
    files.push(summary);
    const manifest = await Csv.create(resolve(directory, 'markets.csv'), [
      'id', 'name', 'stock', 'money', 'ticks', 'first', 'last',
    ]);
    files.push(manifest);
    const marketRange = db.prepare(`
      SELECT count(*) AS n, min(t) AS first, max(t) AS last
      FROM observations WHERE market = ?
    `);
    for (const market of markets) {
      const r = marketRange.get(market.id)!;
      await manifest.row([market.id, market.name, market.stock, market.money,
        r.n, r.first, r.last]);
    }
    const pooled = HORIZONS.map(() => PROFILES.map(() => newStats()));
    const contributing = HORIZONS.map(() => PROFILES.map(() => 0));
    const candidatesTotal = HORIZONS.map(() => 0);
    const missingTotal = HORIZONS.map(() => 0);
    let triangleCount = 0;
    for (const triangle of triangles(markets)) {
      triangleCount++;
      const edges = [triangle.a, triangle.b, triangle.direct];
      for (const [hi, horizon] of HORIZONS.entries()) {
        const current = edges.map((e) => new Reader(db, e.market.id));
        const future = edges.map((e) => new Reader(db, e.market.id));
        const stats = PROFILES.map(() => newStats());
        let candidates = 0;
        let missing = 0;
        for (let t = gridStart; t + horizon <= end; t += STEP) {
          candidates++;
          const now = current.map((r) => r.at(t));
          const then = future.map((r) => r.at(t + horizon));
          if (now.some((r) => r === null) || then.some((r) => r === null)) {
            missing++;
            continue;
          }
          const sample = measure(edges, now as Seen[], then as Seen[], t, horizon);
          for (const [pi, profile] of PROFILES.entries()) {
            if (accepts(profile, sample)) add(stats[pi], sample);
          }
        }
        candidatesTotal[hi] += candidates;
        missingTotal[hi] += missing;
        for (const [pi, profile] of PROFILES.entries()) {
          const s = stats[pi];
          await report(metrics, triangle, horizon, profile, s,
            candidates, missing, s.n ? 1 : 0);
          merge(pooled[hi][pi], s);
          if (s.n) contributing[hi][pi]++;
        }
      }
      console.log(`Triangle ${triangleCount}: ${triangle.id}`);
    }
    if (!triangleCount) throw new Error(`No spot triangles to ${BASE_CURRENCY}`);
    for (const [hi, horizon] of HORIZONS.entries()) {
      for (const [pi, profile] of PROFILES.entries()) {
        await report(summary, null, horizon, profile, pooled[hi][pi],
          candidatesTotal[hi], missingTotal[hi], contributing[hi][pi]);
      }
    }
    // A completed metadata file is written only after all CSV files close.
    while (files.length) await files.pop()!.close();
    await writeFile(resolve(directory, 'metadata.json'), JSON.stringify({
      version: 4, status: 'complete', baseCurrency: BASE_CURRENCY,
      generatedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
      marketType: 'spot', markets: markets.length, triangles: triangleCount,
      observations: range, snapshots, largestSnapshotBytes: largestSnapshot,
      rejectedRows, start: new Date(start).toISOString(),
      end: new Date(end).toISOString(), gridStart, stepMs: STEP,
      horizonsMs: HORIZONS, profiles: PROFILES,
      selection: 'all available two-edge routes with a direct market; no forecast filter',
      extraction: 'archive level 0 only; unchanged ticks retained; duplicate market/timestamp uses last archive value',
      timestamps: 'local receipt time, not exchange event time',
      synchronization: 'last tick <= endpoint, independently at t and t+T; no future lookup',
      filter: 'max age, within-endpoint timestamp skew, and change age across ALL three markets at BOTH endpoints',
      changeAge: 'time since last observed price change; unknown before first observed change; not a quote-age estimate',
      changeCaveat: 'archive gaps can hide changes; first changed tick after a gap is only an observed change time',
      retrospectiveSelection: 'endpoint filters include t+T; this diagnoses consistency and is not a tradable selection rule',
      basis: '1000 * (signed log P_leg1 + signed log P_leg2 - signed log P_direct)',
      deltaBasis: 'synthetic return minus direct return, equal to basis(t+T)-basis(t)',
      units: 'permille log-price and log-return; ages in milliseconds',
      relativeRmse: 'RMSE(deltaBasis) / RMS(direct return); blank if denominator is zero',
      histogram: { min: HIST_MIN, ratio: HIST_RATIO, bins: HIST_BINS,
        lastFiniteUpper: HIST_MIN * HIST_RATIO ** (HIST_BINS - 3),
        quantiles: 'upper bin bounds; <=10% relative bin width above min; blank on overflow or no samples; zero has its own bin' },
      pooling: 'sample weighted, dependent triangles and overlapping horizons; compare profiles within triangle using triangles.csv; pooled changes can reflect composition',
      period: 'full archive by default; no training or holdout in this diagnostic',
      memory: '32 MiB SQLite cache, one decoded archive, six bounded reader pages, fixed histograms; no per-tick output',
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
  const db = new DatabaseSync(':memory:');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(resolve(tmpdir(), 'triangle-v4-test-'));
  try {
    db.exec(`CREATE TABLE observations (
      market INTEGER, t INTEGER, p REAL, PRIMARY KEY(market, t)
    ) WITHOUT ROWID`);
    const insert = db.prepare('INSERT INTO observations VALUES (?, ?, ?)');
    // Cross a page boundary without treating repeated ticks as price changes.
    for (let t = 0; t < PAGE + 20; t++) insert.run(99, t, t < 3 ? 10 : 20);
    const reader = new Reader(db, 99);
    assert.equal(reader.at(-1), null);
    assert.equal(reader.at(2)?.changedAt, null);
    assert.deepEqual(reader.at(PAGE + 5),
      { t: PAGE + 5, p: 20, changedAt: 3 });
    assert.equal(reader.at(PAGE + 100)?.t, PAGE + 19);
    assert.throws(() => reader.at(0), /Nonmonotonic/);
    const markets: Market[] = [
      { id: 0, name: 'A_B', stock: 'A', money: 'B' },
      { id: 1, name: `${BASE_CURRENCY}_B`, stock: BASE_CURRENCY, money: 'B' },
      { id: 2, name: `A_${BASE_CURRENCY}`, stock: 'A', money: BASE_CURRENCY },
    ];
    const all = [...triangles(markets)];
    assert.equal(all.length, 2);
    const triangle = all.find((x) => x.a.from === 'A')!;
    assert.equal(triangle.b.sign, -1);
    const edges = [triangle.a, triangle.b, triangle.direct];
    const origin: Seen[] = [2, 0.25, 8].map((p) =>
      ({ t: 0, p, changedAt: null }));
    const target: Seen[] = [3, 0.2, 15].map((p) =>
      ({ t: 1000, p, changedAt: 1000 }));
    const exact = measure(edges, origin, target, 0, 1000);
    assert.ok(Math.abs(exact.error) < 1e-10);
    assert.equal(exact.changeAge, null);
    assert.ok(accepts({ id: '', age: 0, skew: 0, change: null }, exact));
    assert.ok(!accepts({ id: '', age: 0, skew: 0, change: 1000 }, exact));
    // A constant level basis cancels from the return discrepancy.
    const shiftedOrigin = origin.map((x, i) =>
      ({ ...x, p: x.p * (i === 2 ? 1.03 : 1) }));
    const shiftedTarget = target.map((x, i) =>
      ({ ...x, p: x.p * (i === 2 ? 1.03 : 1) }));
    const constant = measure(edges, shiftedOrigin, shiftedTarget, 0, 1000);
    assert.ok(Math.abs(constant.error) < 1e-10);
    assert.ok(Math.abs(constant.basis + 1000 * Math.log(1.03)) < 1e-10);
    const divergent = measure(edges, origin, shiftedTarget, 0, 1000);
    assert.ok(Math.abs(divergent.error + 1000 * Math.log(1.03)) < 1e-10);
    assert.ok(Math.abs(divergent.error -
      (divergent.futureBasis - divergent.basis)) < 1e-10);
    const stale = measure(edges, origin, target.map((x, i) =>
      ({ ...x, t: i === 0 ? 500 : x.t })), 0, 1000);
    assert.equal(stale.age, 500);
    assert.equal(stale.skew, 500);
    assert.ok(!accepts({ id: '', age: 499, skew: null, change: null }, stale));
    assert.ok(!accepts({ id: '', age: 1000, skew: 250, change: null }, stale));
    const combined = newStats();
    const left = newStats();
    const right = newStats();
    for (const [i, error] of [-3, -1, 0, 2, 7].entries()) {
      const x = { ...exact, error, basis: 2 * error };
      add(combined, x);
      add(i < 2 ? left : right, x);
    }
    merge(left, right);
    for (const key of ['n', 'mean', 'm2', 'meanBasis', 'basisM2', 'abs'] as const) {
      assert.ok(Math.abs(left[key] - combined[key]) < 1e-10, key);
    }
    assert.deepEqual(left.hist, combined.hist);
    assert.ok(quantile(combined, 0.5)! >= 2);
    assert.ok(quantile(combined, 0.5)! <= 2.2);
    assert.equal(quantile(newStats(), 0.5), null);
    const overflow = newStats();
    add(overflow, { ...exact, error: 1e10 });
    assert.equal(quantile(overflow, 0.99), null);
    assert.equal(overflow.hist[HIST_BINS - 1], 1);
    // Exercise the endpoint loop on coherent prices, including inverse quotes.
    for (let t = 0; t <= 40_000; t += 1000) {
      const a = 2 + t / 100_000;
      const b = 4 + t / 200_000;
      for (const [market, p] of [a, 1 / b, a * b].entries()) insert.run(market, t, p);
    }
    const current = edges.map((e) => new Reader(db, e.market.id));
    const future = edges.map((e) => new Reader(db, e.market.id));
    const profile: Profile = { id: 'test', age: 1000, skew: 250, change: 1000 };
    const s = newStats();
    for (let t = 0; t <= 30_000; t += 10_000) {
      const x = measure(edges, current.map((r) => r.at(t)!),
        future.map((r) => r.at(t + 10_000)!), t, 10_000);
      if (accepts(profile, x)) add(s, x);
    }
    assert.equal(s.n, 3);
    assert.ok(s.max < 1e-10);
    const csv = await Csv.create(resolve(directory, 'test.csv'), HEADERS);
    try {
      await report(csv, triangle, 10_000, profile, s, 4, 0, 1);
      await report(csv, triangle, 10_000, profile, newStats(), 4, 0, 0);
    } finally { await csv.close(); }
    const { readFile } = await import('node:fs/promises');
    const lines = (await readFile(resolve(directory, 'test.csv'), 'utf8'))
      .trim().split('\n');
    assert.equal(lines.length, 3);
    for (const line of lines) assert.equal(line.split(',').length, HEADERS.length);
    assert.ok(!lines.join('\n').includes('NaN'));
    console.log('V4 self-test passed: readers, inverse edges, basis identity,');
    console.log('endpoint filters, unchanged ticks, histograms and CSV output.');
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
