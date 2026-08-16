// app/src/server/services/market-statistics-persistence-queue.ts

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { SECONDS } from '../../shared/constants/time.js';
import { SERVER_EVENT } from '../constants/events.js';
import { marketCandlesDao } from '../dao/market-candles.js';
import type {
  MarketCandleAddRow,
  MarketCandleIndicatorsChange,
  MarketStatisticsPersistenceChanges,
} from '../types/persistence.js';
import { CandleKeyMap } from '../utilities/candle-key-map.js';
import { eventBus } from './event-bus.js';

const isCpuProfiling = process.execArgv.some(
  (arg) => arg.startsWith('--cpu-prof'),
);

const MAX_MARKETS_PER_BATCH = 20;
const MAX_CANDLES_PER_BATCH = 100;
const MAX_INDICATOR_CHANGES_PER_BATCH = 4_000;

const MIN_PENDING_AGE = 250;
const BACKLOG_BYPASS_AGE_MARKETS = 100;

const MAX_FAILED_ATTEMPTS = 8;
const RETRY_BASE_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 10_000;

const QUEUE_MONITOR_INTERVAL = 10 * SECONDS;
const EVENT_LOOP_MONITOR_INTERVAL = 10 * SECONDS;

const STOP_POLL_INTERVAL = 10;

interface PendingMarketPersistence {
  readonly marketName: string;
  readonly queuedAt: number;
  readonly newCandles: CandleKeyMap<MarketCandleAddRow>;
  readonly indicatorChanged: CandleKeyMap<MarketCandleIndicatorsChange>;
  readonly deleteBefore: Map<number, number>;
}

interface PersistenceBatchItem {
  readonly marketName: string;
  readonly changes: MarketStatisticsPersistenceChanges;
}

export class MarketStatisticsPersistenceQueueService {
  private readonly pendingByMarket =
    new Map<string, PendingMarketPersistence>();

  private activeBatch: PersistenceBatchItem[] | null = null;

  private diagnosticMode = false;
  private diagnosticIndex = 0;

  private workerTimer: ReturnType<typeof setTimeout> | null = null;
  private queueMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private eventLoopMonitorTimer: ReturnType<typeof setInterval> | null = null;

  private workerBusy = false;
  private isStopping = false;

  private failedAttempts = 0;
  private retryAt = 0;

  private processedMarkets = 0;
  private processedCandles = 0;
  private processedIndicatorChanges = 0;

  private readonly eventLoopDelay = monitorEventLoopDelay({
    resolution: 20,
  });

  private lastEventLoopUtilization =
    performance.eventLoopUtilization();

  private lastCpuUsage = process.cpuUsage();

  private unsubscribePersistenceChanged: (() => void) | null = null;

  public start(): void {
    if (this.unsubscribePersistenceChanged) {
      return;
    }

    this.isStopping = false;

    this.unsubscribePersistenceChanged = eventBus.on(
      SERVER_EVENT.marketStatisticsPersistenceChanged,
      (event) => this.handlePersistenceChanged(event),
    );

    this.queueMonitorTimer = setInterval(
      () => { this.logQueueState(); },
      QUEUE_MONITOR_INTERVAL,
    );

    this.eventLoopDelay.enable();

    this.lastEventLoopUtilization =
      performance.eventLoopUtilization();

    this.lastCpuUsage = process.cpuUsage();

    this.eventLoopMonitorTimer = setInterval(
      () => { this.logRuntimeState(); },
      EVENT_LOOP_MONITOR_INTERVAL,
    );

    this.scheduleWorker();
  }

  public async stop(): Promise<void> {
    this.isStopping = true;

    this.unsubscribePersistenceChanged?.();
    this.unsubscribePersistenceChanged = null;

    this.clearWorkerTimer();

    if (this.queueMonitorTimer) {
      clearInterval(this.queueMonitorTimer);
      this.queueMonitorTimer = null;
    }

    if (this.eventLoopMonitorTimer) {
      clearInterval(this.eventLoopMonitorTimer);
      this.eventLoopMonitorTimer = null;
    }

    this.eventLoopDelay.disable();

    while (this.workerBusy || this.hasPendingWork()) {
      if (!this.workerBusy) {
        const retryDelay = Math.max(0, this.retryAt - Date.now());

        if (retryDelay === 0) {
          await this.workerTick();
          continue;
        }
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, STOP_POLL_INTERVAL);
      });
    }

    this.isStopping = false;
  }

  private handlePersistenceChanged(
    changes: MarketStatisticsPersistenceChanges,
  ): void {
    if (
      changes.newCandles.length === 0 &&
      changes.deleteBefore.length === 0 &&
      changes.indicatorChanged.length === 0
    ) {
      return;
    }

    const marketName = this.getMarketName(changes);
    const pending = this.getOrCreatePending(marketName);

    this.mergeRemovals(pending, changes);
    this.mergeCandles(pending, changes);
    this.mergeIndicatorChanges(pending, changes);

    this.scheduleWorker();
  }

  private mergeRemovals(
    pending: PendingMarketPersistence,
    changes: MarketStatisticsPersistenceChanges,
  ): void {
    for (const removal of changes.deleteBefore) {
      const current = pending.deleteBefore.get(removal.level);

      if (
        current !== undefined &&
        current >= removal.timeThreshold
      ) {
        continue;
      }

      pending.deleteBefore.set(
        removal.level,
        removal.timeThreshold,
      );

      pending.newCandles.deleteBefore(
        removal.level,
        removal.timeThreshold,
      );

      pending.indicatorChanged.deleteBefore(
        removal.level,
        removal.timeThreshold,
      );
    }
  }

  private mergeCandles(
    pending: PendingMarketPersistence,
    changes: MarketStatisticsPersistenceChanges,
  ): void {
    for (const candle of changes.newCandles) {
      this.checkNotRemoved(
        pending,
        candle.level,
        candle.endedAt,
        'candle',
      );

      pending.newCandles.set(
        candle.level,
        candle.startedAt,
        candle.endedAt,
        candle,
      );
    }
  }

  private mergeIndicatorChanges(
    pending: PendingMarketPersistence,
    changes: MarketStatisticsPersistenceChanges,
  ): void {
    for (const change of changes.indicatorChanged) {
      this.checkNotRemoved(
        pending,
        change.level,
        change.endedAt,
        'indicator change',
      );

      const existing = pending.indicatorChanged.get(
        change.level,
        change.startedAt,
        change.endedAt,
      );

      if (existing) {
        Object.assign(existing.indicators, change.indicators);
        continue;
      }

      pending.indicatorChanged.set(
        change.level,
        change.startedAt,
        change.endedAt,
        change,
      );
    }
  }

  private checkNotRemoved(
    pending: PendingMarketPersistence,
    level: number,
    endedAt: number,
    entityName: string,
  ): void {
    const timeThreshold = pending.deleteBefore.get(level);

    if (
      timeThreshold === undefined ||
      endedAt >= timeThreshold
    ) {
      return;
    }

    throw new Error(
      `Cannot enqueue ${entityName} for market "${pending.marketName}", ` +
      `level ${level}: endedAt ${endedAt} is before ` +
      `delete threshold ${timeThreshold}`,
    );
  }

  private scheduleWorker(): void {
    if (
      this.isStopping ||
      this.workerBusy ||
      this.workerTimer
    ) {
      return;
    }

    const delay = this.getNextWorkerDelay();

    if (delay === null) {
      return;
    }

    this.workerTimer = setTimeout(() => {
      this.workerTimer = null;
      void this.workerTick();
    }, delay);
  }

  private getNextWorkerDelay(): number | null {
    if (this.activeBatch) {
      return Math.max(0, this.retryAt - Date.now());
    }

    if (this.pendingByMarket.size === 0) {
      return null;
    }

    if (
      this.isStopping ||
      this.pendingByMarket.size >= BACKLOG_BYPASS_AGE_MARKETS
    ) {
      return 0;
    }

    const firstPending =
      this.pendingByMarket.values().next().value;

    if (!firstPending) {
      return null;
    }

    return Math.max(
      0,
      firstPending.queuedAt + MIN_PENDING_AGE - Date.now(),
    );
  }

  private async workerTick(): Promise<void> {
    if (this.workerBusy) {
      return;
    }

    if (this.retryAt > Date.now()) {
      this.scheduleWorker();
      return;
    }

    if (!this.activeBatch) {
      this.activeBatch = this.takeNextBatch();

      if (this.activeBatch.length === 0) {
        this.activeBatch = null;
        this.scheduleWorker();
        return;
      }
    }

    this.workerBusy = true;

    const batch = this.getCurrentBatch();

    try {
      const changes = this.mergeBatch(batch);
      const startedAt = Date.now();

      if (isCpuProfiling) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      } else {
        await marketCandlesDao.applyPersistenceChanges(changes);
      }

      const duration = Date.now() - startedAt;

      this.handleBatchSuccess(batch, changes);

      if (duration >= 100) {
        console.warn('Slow persistence worker batch', {
          duration,
          markets: batch.length,
          candles: changes.newCandles.length,
          indicatorChanges: changes.indicatorChanged.length,
        });
      }
    } catch (error) {
      this.handleBatchFailure(error);
    } finally {
      this.workerBusy = false;

      if (!this.isStopping) {
        this.scheduleWorker();
      }
    }
  }

  private takeNextBatch(): PersistenceBatchItem[] {
    const batch: PersistenceBatchItem[] = [];

    const bypassAge =
      this.isStopping ||
      this.pendingByMarket.size >= BACKLOG_BYPASS_AGE_MARKETS;

    const now = Date.now();

    let candlesCount = 0;
    let indicatorChangesCount = 0;

    for (const [marketName, pending] of this.pendingByMarket) {
      if (
        !bypassAge &&
        now - pending.queuedAt < MIN_PENDING_AGE
      ) {
        break;
      }

      const nextCandlesCount =
        candlesCount + pending.newCandles.size;

      const nextIndicatorChangesCount =
        indicatorChangesCount + pending.indicatorChanged.size;

      const exceedsCostLimit =
        nextCandlesCount > MAX_CANDLES_PER_BATCH ||
        nextIndicatorChangesCount >
          MAX_INDICATOR_CHANGES_PER_BATCH;

      if (batch.length > 0 && exceedsCostLimit) {
        break;
      }

      batch.push({
        marketName,
        changes: this.materializePending(pending),
      });

      this.pendingByMarket.delete(marketName);

      candlesCount = nextCandlesCount;
      indicatorChangesCount = nextIndicatorChangesCount;

      if (
        batch.length >= MAX_MARKETS_PER_BATCH ||
        candlesCount >= MAX_CANDLES_PER_BATCH ||
        indicatorChangesCount >= MAX_INDICATOR_CHANGES_PER_BATCH
      ) {
        break;
      }
    }

    return batch;
  }

  private materializePending(
    pending: PendingMarketPersistence,
  ): MarketStatisticsPersistenceChanges {
    return {
      newCandles: Array.from(pending.newCandles.values()),

      deleteBefore: Array.from(
        pending.deleteBefore,
        ([level, timeThreshold]) => ({
          marketName: pending.marketName,
          level,
          timeThreshold,
        }),
      ),

      indicatorChanged: Array.from(
        pending.indicatorChanged.values(),
      ),
    };
  }

  private getCurrentBatch(): PersistenceBatchItem[] {
    if (!this.activeBatch) {
      return [];
    }

    if (!this.diagnosticMode) {
      return this.activeBatch;
    }

    const item = this.activeBatch[this.diagnosticIndex];

    if (!item) {
      throw new Error(
        `Invalid persistence diagnostic index: ${this.diagnosticIndex}`,
      );
    }

    return [item];
  }

  private mergeBatch(
    batch: readonly PersistenceBatchItem[],
  ): MarketStatisticsPersistenceChanges {
    return {
      newCandles: batch.flatMap(
        (item) => item.changes.newCandles,
      ),

      deleteBefore: batch.flatMap(
        (item) => item.changes.deleteBefore,
      ),

      indicatorChanged: batch.flatMap(
        (item) => item.changes.indicatorChanged,
      ),
    };
  }

  private handleBatchSuccess(
    batch: readonly PersistenceBatchItem[],
    changes: MarketStatisticsPersistenceChanges,
  ): void {
    this.processedMarkets += batch.length;
    this.processedCandles += changes.newCandles.length;
    this.processedIndicatorChanges +=
      changes.indicatorChanged.length;

    this.failedAttempts = 0;
    this.retryAt = 0;

    if (!this.diagnosticMode) {
      this.activeBatch = null;
      return;
    }

    this.diagnosticIndex += 1;

    if (
      this.activeBatch &&
      this.diagnosticIndex < this.activeBatch.length
    ) {
      return;
    }

    this.finishDiagnosticMode();
  }

  private handleBatchFailure(error: unknown): void {
    if (!this.activeBatch) {
      throw new Error(
        'Persistence worker failed without an active batch',
      );
    }

    this.failedAttempts += 1;

    if (this.failedAttempts < MAX_FAILED_ATTEMPTS) {
      const retryDelay = Math.min(
        RETRY_BASE_DELAY_MS *
          2 ** (this.failedAttempts - 1),
        MAX_RETRY_DELAY_MS,
      );

      this.retryAt = Date.now() + retryDelay;

      console.error('Persistence worker failed', {
        error,
        attempt: this.failedAttempts,
        retryDelay,
        diagnosticMode: this.diagnosticMode,
      });

      return;
    }

    if (
      !this.diagnosticMode &&
      this.activeBatch.length > 1
    ) {
      this.diagnosticMode = true;
      this.diagnosticIndex = 0;
      this.failedAttempts = 0;
      this.retryAt = 0;

      console.error(
        'Persistence batch failed repeatedly; switching to single-market mode',
        {
          error,
          markets: this.activeBatch.length,
        },
      );

      return;
    }

    const failedItem =
      this.activeBatch[this.diagnosticIndex];

    if (!failedItem) {
      throw new Error(
        `Invalid persistence diagnostic index: ${this.diagnosticIndex}`,
      );
    }

    console.error(
      'Dropping persistence changes after repeated failures',
      {
        error,
        attempts: this.failedAttempts,
        marketName: failedItem.marketName,
        changes: failedItem.changes,
      },
    );

    this.failedAttempts = 0;
    this.retryAt = 0;

    if (!this.diagnosticMode) {
      this.activeBatch = null;
      return;
    }

    this.diagnosticIndex += 1;

    if (this.diagnosticIndex < this.activeBatch.length) {
      return;
    }

    this.finishDiagnosticMode();
  }

  private finishDiagnosticMode(): void {
    this.activeBatch = null;
    this.diagnosticMode = false;
    this.diagnosticIndex = 0;
    this.failedAttempts = 0;
    this.retryAt = 0;
  }

  private getOrCreatePending(
    marketName: string,
  ): PendingMarketPersistence {
    let pending = this.pendingByMarket.get(marketName);

    if (pending) {
      return pending;
    }

    pending = {
      marketName,
      queuedAt: Date.now(),
      newCandles: new CandleKeyMap<MarketCandleAddRow>(),
      indicatorChanged:
        new CandleKeyMap<MarketCandleIndicatorsChange>(),
      deleteBefore: new Map<number, number>(),
    };

    this.pendingByMarket.set(marketName, pending);

    return pending;
  }

  private getMarketName(
    changes: MarketStatisticsPersistenceChanges,
  ): string {
    const marketName =
      changes.newCandles[0]?.marketName ??
      changes.deleteBefore[0]?.marketName ??
      changes.indicatorChanged[0]?.marketName;

    if (!marketName) {
      throw new Error(
        'Cannot determine market name from empty persistence changes',
      );
    }

    this.validateMarketNames(changes, marketName);

    return marketName;
  }

  private validateMarketNames(
    changes: MarketStatisticsPersistenceChanges,
    expectedMarketName: string,
  ): void {
    for (const candle of changes.newCandles) {
      if (candle.marketName !== expectedMarketName) {
        throw new Error(
          `Persistence changes contain multiple markets: ` +
          `"${expectedMarketName}" and "${candle.marketName}"`,
        );
      }
    }

    for (const removal of changes.deleteBefore) {
      if (removal.marketName !== expectedMarketName) {
        throw new Error(
          `Persistence changes contain multiple markets: ` +
          `"${expectedMarketName}" and "${removal.marketName}"`,
        );
      }
    }

    for (const change of changes.indicatorChanged) {
      if (change.marketName !== expectedMarketName) {
        throw new Error(
          `Persistence changes contain multiple markets: ` +
          `"${expectedMarketName}" and "${change.marketName}"`,
        );
      }
    }
  }

  private hasPendingWork(): boolean {
    return (
      this.activeBatch !== null ||
      this.pendingByMarket.size > 0
    );
  }

  private clearWorkerTimer(): void {
    if (!this.workerTimer) {
      return;
    }

    clearTimeout(this.workerTimer);
    this.workerTimer = null;
  }

  private logQueueState(): void {
    let markets = this.pendingByMarket.size;
    let candles = 0;
    let indicatorChanges = 0;
    let deleteBefore = 0;

    for (const pending of this.pendingByMarket.values()) {
      candles += pending.newCandles.size;
      indicatorChanges += pending.indicatorChanged.size;
      deleteBefore += pending.deleteBefore.size;
    }

    if (this.activeBatch) {
      const startIndex =
        this.diagnosticMode ? this.diagnosticIndex : 0;

      markets += this.activeBatch.length - startIndex;

      for (
        let index = startIndex;
        index < this.activeBatch.length;
        index += 1
      ) {
        const changes = this.activeBatch[index].changes;

        candles += changes.newCandles.length;
        indicatorChanges += changes.indicatorChanged.length;
        deleteBefore += changes.deleteBefore.length;
      }
    }

    console.log('Market statistics persistence queue', {
      markets,
      candles,
      indicatorChanges,
      deleteBefore,
      workerBusy: this.workerBusy,
      failedAttempts: this.failedAttempts,
      retryDelayMs: Math.max(0, this.retryAt - Date.now()),
      diagnosticMode: this.diagnosticMode,
      processedMarkets: this.processedMarkets,
      processedCandles: this.processedCandles,
      processedIndicatorChanges: this.processedIndicatorChanges,
    });

    this.processedMarkets = 0;
    this.processedCandles = 0;
    this.processedIndicatorChanges = 0;
  }

  private logRuntimeState(): void {
    const eventLoopUtilization = performance.eventLoopUtilization(
      this.lastEventLoopUtilization,
    );

    this.lastEventLoopUtilization =
      performance.eventLoopUtilization();

    const cpuUsage = process.cpuUsage(this.lastCpuUsage);

    this.lastCpuUsage = process.cpuUsage();

    const toMilliseconds = (nanoseconds: number): number =>
      nanoseconds / 1_000_000;

    console.log(
      'Market statistics runtime state',
      {
        eventLoopUtilization:
          Number(eventLoopUtilization.utilization.toFixed(3)),

        eventLoopDelayMeanMs:
          Number(toMilliseconds(this.eventLoopDelay.mean).toFixed(2)),

        eventLoopDelayMaxMs:
          Number(toMilliseconds(this.eventLoopDelay.max).toFixed(2)),

        eventLoopDelayP99Ms:
          Number(
            toMilliseconds(this.eventLoopDelay.percentile(99)).toFixed(2),
          ),

        cpuUserMs: Math.round(cpuUsage.user / 1_000),

        cpuSystemMs: Math.round(cpuUsage.system / 1_000),

        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),

        heapUsedMb: Math.round(
          process.memoryUsage().heapUsed / 1024 / 1024,
        ),

        workerBusy: this.workerBusy,
      },
    );

    this.eventLoopDelay.reset();
  }
}

export const marketStatisticsPersistenceQueueService =
  new MarketStatisticsPersistenceQueueService();
