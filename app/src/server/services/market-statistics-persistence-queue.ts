// app/src/server/services/market-statistics-persistence-queue.ts

// app/src/server/services/market-statistics-persistence-queue.ts

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { SECONDS } from '../../shared/constants/time.js';
import { SERVER_EVENT } from '../constants/events.js';
import { marketCandlesDao } from '../dao/market-candles.js';
import type {
  MarketStatisticsPersistenceChanges,
} from '../types/persistence.js';
import { eventBus } from './event-bus.js';

const isCpuProfiling = process.execArgv.some(
  (arg) => arg.startsWith('--cpu-prof'),
);

const WORKER_INTERVAL = 10;

const ITEMS_PER_BATCH = 20;

const MAX_FAILED_ATTEMPTS = 8;
const RETRY_BASE_SKIP_CYCLES = 10;
const MAX_RETRY_SKIP_CYCLES = 1_000;

const QUEUE_COMPACT_HEAD = 1_024;

const QUEUE_MONITOR_INTERVAL = 10 * SECONDS;
const EVENT_LOOP_MONITOR_INTERVAL = 10 * SECONDS;

const STOP_POLL_INTERVAL = 10;

export class MarketStatisticsPersistenceQueueService {
  private queue: MarketStatisticsPersistenceChanges[] = [];
  private queueHead = 0;

  private workerTimer: ReturnType<typeof setInterval> | null = null;
  private queueMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private eventLoopMonitorTimer: ReturnType<typeof setInterval> | null = null;

  private workerBusy = false;

  private failedAttempts = 0;
  private skippedCycles = 0;

  /*
   * After a repeatedly failing batch, process all items from that batch
   * individually to identify and drop only an invalid item.
   */
  private diagnosticItemsRemaining = 0;

  private processedItems = 0;
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

    this.unsubscribePersistenceChanged = eventBus.on(
      SERVER_EVENT.marketStatisticsPersistenceChanged,
      (event) => this.handlePersistenceChanged(event),
    );

    this.workerTimer = setInterval(
      () => { void this.workerTick(); },
      WORKER_INTERVAL,
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
  }

  public async stop(): Promise<void> {
    this.unsubscribePersistenceChanged?.();
    this.unsubscribePersistenceChanged = null;

    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }

    if (this.queueMonitorTimer) {
      clearInterval(this.queueMonitorTimer);
      this.queueMonitorTimer = null;
    }

    if (this.eventLoopMonitorTimer) {
      clearInterval(this.eventLoopMonitorTimer);
      this.eventLoopMonitorTimer = null;
    }

    this.eventLoopDelay.disable();

    while (this.workerBusy || this.getQueueSize() > 0) {
      if (!this.workerBusy) {
        await this.workerTick();
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, STOP_POLL_INTERVAL);
      });
    }
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

    this.queue.push(changes);
  }

  private async workerTick(): Promise<void> {
    if (this.workerBusy || this.getQueueSize() === 0) {
      return;
    }

    if (this.skippedCycles > 0) {
      this.skippedCycles -= 1;
      return;
    }

    this.workerBusy = true;

    const batchSize =
      this.diagnosticItemsRemaining > 0
        ? 1
        : ITEMS_PER_BATCH;

    const batch = this.peekBatch(batchSize);

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
          items: batch.length,
          candles: changes.newCandles.length,
          indicatorChanges: changes.indicatorChanged.length,
        });
      }
    } catch (error) {
      this.handleBatchFailure(error, batch.length);
    } finally {
      this.workerBusy = false;
    }
  }

  private peekBatch(
    limit: number,
  ): MarketStatisticsPersistenceChanges[] {
    const end = Math.min(
      this.queueHead + limit,
      this.queue.length,
    );

    return this.queue.slice(this.queueHead, end);
  }

  private mergeBatch(
    batch: readonly MarketStatisticsPersistenceChanges[],
  ): MarketStatisticsPersistenceChanges {
    return {
      newCandles: batch.flatMap((item) => item.newCandles),
      deleteBefore: batch.flatMap((item) => item.deleteBefore),
      indicatorChanged: batch.flatMap((item) => item.indicatorChanged),
    };
  }

  private handleBatchSuccess(
    batch: readonly MarketStatisticsPersistenceChanges[],
    changes: MarketStatisticsPersistenceChanges,
  ): void {
    this.queueHead += batch.length;

    this.processedItems += batch.length;
    this.processedCandles += changes.newCandles.length;
    this.processedIndicatorChanges += changes.indicatorChanged.length;

    this.failedAttempts = 0;
    this.skippedCycles = 0;

    if (this.diagnosticItemsRemaining > 0) {
      this.diagnosticItemsRemaining -= batch.length;
    }

    this.compactQueue();
  }

  private handleBatchFailure(
    error: unknown,
    batchSize: number,
  ): void {
    this.failedAttempts += 1;

    if (this.failedAttempts < MAX_FAILED_ATTEMPTS) {
      this.skippedCycles = Math.min(
        RETRY_BASE_SKIP_CYCLES *
          2 ** (this.failedAttempts - 1),
        MAX_RETRY_SKIP_CYCLES,
      );

      console.error('Persistence worker failed', {
        error,
        attempt: this.failedAttempts,
        retryAfterCycles: this.skippedCycles,
        diagnosticMode: this.diagnosticItemsRemaining > 0,
      });

      return;
    }

    if (
      this.diagnosticItemsRemaining === 0 &&
      batchSize > 1
    ) {
      this.diagnosticItemsRemaining = batchSize;
      this.failedAttempts = 0;
      this.skippedCycles = 0;

      console.error(
        'Persistence batch failed repeatedly; switching to single-item mode',
        {
          error,
          items: batchSize,
        },
      );

      return;
    }

    const failedItem = this.queue[this.queueHead];

    console.error(
      'Dropping persistence item after repeated failures',
      {
        error,
        attempts: this.failedAttempts,
        item: failedItem,
      },
    );

    this.queueHead += 1;

    if (this.diagnosticItemsRemaining > 0) {
      this.diagnosticItemsRemaining -= 1;
    }

    this.failedAttempts = 0;
    this.skippedCycles = 0;

    this.compactQueue();
  }

  private compactQueue(): void {
    if (this.queueHead === 0) {
      return;
    }

    if (
      this.queueHead < QUEUE_COMPACT_HEAD &&
      this.queueHead * 2 < this.queue.length
    ) {
      return;
    }

    this.queue = this.queue.slice(this.queueHead);
    this.queueHead = 0;
  }

  private getQueueSize(): number {
    return this.queue.length - this.queueHead;
  }

  private logQueueState(): void {
    let candles = 0;
    let indicatorChanges = 0;
    let deleteBefore = 0;

    for (
      let index = this.queueHead;
      index < this.queue.length;
      index += 1
    ) {
      const item = this.queue[index];

      candles += item.newCandles.length;
      indicatorChanges += item.indicatorChanged.length;
      deleteBefore += item.deleteBefore.length;
    }

    console.log('Market statistics persistence queue', {
      items: this.getQueueSize(),
      candles,
      indicatorChanges,
      deleteBefore,
      workerBusy: this.workerBusy,
      failedAttempts: this.failedAttempts,
      skippedCycles: this.skippedCycles,
      diagnosticItemsRemaining: this.diagnosticItemsRemaining,
      processedItems: this.processedItems,
      processedCandles: this.processedCandles,
      processedIndicatorChanges: this.processedIndicatorChanges,
    });

    this.processedItems = 0;
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
