// app/src/server/services/storage-persistence.ts

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import { SECONDS } from '../../shared/constants/time.js';
import type {
  ActiveStoragePersistenceSnapshot,
  ArchiveStoragePersistenceSnapshot,
  StoragePersistenceSnapshot,
} from '../../shared/types/storage.js';
import { SERVER_EVENT } from '../constants/events.js';
import { SNAPSHOT_BATCH_SIZE, isCpuProfiling } from '../constants/persistence.js';
import { storageDao } from '../db/dao/storage.js';
import { eventBus } from './event-bus.js';
import type { StorageSnapshotedEvent } from '../types/events.js';

const MIN_PENDING_AGE = 250;
const BACKLOG_BYPASS_AGE_SNAPSHOTS = 100;

const RETRY_BASE_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 10 * SECONDS;

const QUEUE_MONITOR_INTERVAL = 10 * SECONDS;
const EVENT_LOOP_MONITOR_INTERVAL = 10 * SECONDS;

const STOP_POLL_INTERVAL = 10;

interface PendingActiveSnapshot {
  snapshot: ActiveStoragePersistenceSnapshot;
  queuedAt: number;
  version: number;
}

interface PendingArchiveSnapshot {
  snapshot: ArchiveStoragePersistenceSnapshot;
  queuedAt: number;
}

interface ActiveBatchItem {
  marketName: string;
  snapshot: ActiveStoragePersistenceSnapshot;
  version: number;
}

type PersistenceBatch =
  | {
      snapshotType: 'active';
      items: ActiveBatchItem[];
    }
  | {
      snapshotType: 'archive';
      items: PendingArchiveSnapshot[];
    };

export class StoragePersistenceService {
  private readonly pendingActive =
    new Map<string, PendingActiveSnapshot>();

  private readonly pendingArchive: PendingArchiveSnapshot[] = [];

  private workerTimer: ReturnType<typeof setTimeout> | null = null;

  private queueMonitorTimer:
    ReturnType<typeof setInterval> | null = null;

  private eventLoopMonitorTimer:
    ReturnType<typeof setInterval> | null = null;

  private workerBusy = false;
  private isStopping = false;

  private failedAttempts = 0;
  private retryAt = 0;

  private processedActiveSnapshots = 0;
  private processedArchiveSnapshots = 0;

  private readonly eventLoopDelay = monitorEventLoopDelay({
    resolution: 20,
  });

  private lastEventLoopUtilization =
    performance.eventLoopUtilization();

  private lastCpuUsage = process.cpuUsage();

  private unsubscribeStorageSnapshoted: (() => void) | null = null;

  public start(): void {
    if (this.unsubscribeStorageSnapshoted) {
      return;
    }

    this.isStopping = false;

    this.unsubscribeStorageSnapshoted = eventBus.on(
      SERVER_EVENT.storageSnapshoted,
      (event) => { this.handleStorageSnapshoted(event); },
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

    this.unsubscribeStorageSnapshoted?.();
    this.unsubscribeStorageSnapshoted = null;

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
        const retryDelay = Math.max(
          0,
          this.retryAt - Date.now(),
        );

        if (retryDelay === 0) {
          await this.workerTick();
          continue;
        }
      }

      await new Promise<void>(
        (resolve) => {
          setTimeout(resolve, STOP_POLL_INTERVAL);
        },
      );
    }

    this.isStopping = false;
  }

  public async getAliveMarketNames(): Promise<string[]> {
    return storageDao.getAliveMarketNames();
  }

  public async getAliveForRestore(
    marketNames: string[],
  ): Promise<StoragePersistenceSnapshot[]> {
    const cached = new Map<string, StoragePersistenceSnapshot>();
    const uncached: string[] = [];

    for (const marketName of marketNames) {
      const pending = this.pendingActive.get(marketName);

      if (pending) {
        cached.set(marketName, pending.snapshot);
      } else {
        uncached.push(marketName);
      }
    }

    const fromDatabase = uncached.length > 0
      ? await storageDao.getAliveForRestore(uncached)
      : [];
    const byMarket = new Map(
      fromDatabase.map((snapshot) => [snapshot.marketName, snapshot]),
    );

    for (const [marketName, snapshot] of cached) {
      byMarket.set(marketName, snapshot);
    }

    // Snapshots queued during the database read take precedence as well.
    for (const marketName of marketNames) {
      const pending = this.pendingActive.get(marketName);

      if (pending) {
        byMarket.set(marketName, pending.snapshot);
      }
    }

    return marketNames.flatMap((marketName) => {
      const snapshot = byMarket.get(marketName);
      return snapshot ? [snapshot] : [];
    });
  }

  public async getLastArchiveEndedAt(
    marketName: string,
  ): Promise<number> {
    return storageDao.getLastArchiveEndedAt(marketName);
  }

  private handleStorageSnapshoted(
    event: StorageSnapshotedEvent,
  ): void {
    const queuedAt = Date.now();

    for (const snapshot of event.snapshots) {
      if (snapshot.snapshotType === 'active') {
        this.addActiveSnapshot(snapshot, queuedAt);
      } else {
        this.pendingArchive.push({
          snapshot,
          queuedAt,
        });
      }
    }

    this.scheduleWorker();
  }

  private addActiveSnapshot(
    snapshot: ActiveStoragePersistenceSnapshot,
    queuedAt: number,
  ): void {
    const pending = this.pendingActive.get(snapshot.marketName);

    if (pending) {
      pending.snapshot = snapshot;
      pending.version++;
      return;
    }

    this.pendingActive.set(snapshot.marketName, {
      snapshot,
      queuedAt,
      version: 0,
    });
  }

  private scheduleWorker(): void {
    if (this.isStopping || this.workerBusy || this.workerTimer) {
      return;
    }

    const delay = this.getNextWorkerDelay();

    if (delay === null) {
      return;
    }

    this.workerTimer = setTimeout(
      () => {
        this.workerTimer = null;
        void this.workerTick();
      },
      delay,
    );
  }

  private getNextWorkerDelay(): number | null {
    if (!this.hasPendingWork()) {
      return null;
    }

    if (this.retryAt > Date.now()) {
      return this.retryAt - Date.now();
    }

    if (
      this.isStopping ||
      this.getPendingCount() >= BACKLOG_BYPASS_AGE_SNAPSHOTS
    ) {
      return 0;
    }

    const queuedAt = this.getOldestQueuedAt();

    if (queuedAt === null) {
      return null;
    }

    return Math.max(
      0,
      queuedAt + MIN_PENDING_AGE - Date.now(),
    );
  }

  private async workerTick(): Promise<void> {
    if (this.workerBusy) {
      return;
    }

    if (this.retryAt > Date.now()) {
      if (!this.isStopping) {
        this.scheduleWorker();
      }

      return;
    }

    const batch = this.getNextBatch();

    if (!batch) {
      if (!this.isStopping) {
        this.scheduleWorker();
      }

      return;
    }

    this.workerBusy = true;

    try {
      const startedAt = Date.now();

      if (isCpuProfiling) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      } else if (batch.snapshotType === 'active') {
        await storageDao.upsertAlive(
          batch.items.map((item) => item.snapshot),
        );
      } else {
        await storageDao.insertArchive(
          batch.items.map((item) => item.snapshot),
        );
      }

      const duration = Date.now() - startedAt;

      this.handleBatchSuccess(batch);

      if (duration >= 100) {
        console.warn(
          'Slow storage persistence worker batch',
          {
            duration,
            snapshotType: batch.snapshotType,
            snapshots: batch.items.length,
          },
        );
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

  private getNextBatch(): PersistenceBatch | null {
    const activeQueuedAt = this.getOldestActiveQueuedAt();
    const archiveQueuedAt = this.pendingArchive[0]?.queuedAt;

    if (
      archiveQueuedAt !== undefined &&
      (
        activeQueuedAt === null ||
        archiveQueuedAt <= activeQueuedAt
      )
    ) {
      return {
        snapshotType: 'archive',
        items: this.pendingArchive.slice(0, SNAPSHOT_BATCH_SIZE),
      };
    }

    if (activeQueuedAt !== null) {
      return {
        snapshotType: 'active',
        items: this.getActiveBatch(),
      };
    }

    return null;
  }

  private getActiveBatch(): ActiveBatchItem[] {
    const result: ActiveBatchItem[] = [];

    for (const [marketName, pending] of this.pendingActive) {
      result.push({
        marketName,
        snapshot: pending.snapshot,
        version: pending.version,
      });

      if (result.length >= SNAPSHOT_BATCH_SIZE) {
        break;
      }
    }

    return result;
  }

  private handleBatchSuccess(batch: PersistenceBatch): void {
    if (batch.snapshotType === 'active') {
      this.handleActiveBatchSuccess(batch.items);
      this.processedActiveSnapshots += batch.items.length;
    } else {
      this.pendingArchive.splice(0, batch.items.length);
      this.processedArchiveSnapshots += batch.items.length;
    }

    this.failedAttempts = 0;
    this.retryAt = 0;
  }

  private handleActiveBatchSuccess(
    items: readonly ActiveBatchItem[],
  ): void {
    for (const item of items) {
      const pending = this.pendingActive.get(item.marketName);

      if (!pending || pending.version !== item.version) {
        continue;
      }

      this.pendingActive.delete(item.marketName);
    }
  }

  private handleBatchFailure(error: unknown): void {
    this.failedAttempts++;

    const exponent = Math.min(this.failedAttempts - 1, 30);

    const retryDelay = Math.min(
      RETRY_BASE_DELAY_MS * 2 ** exponent,
      MAX_RETRY_DELAY_MS,
    );

    this.retryAt = Date.now() + retryDelay;

    console.error(
      'Storage persistence worker failed',
      {
        error,
        attempt: this.failedAttempts,
        retryDelay,
        activePending: this.pendingActive.size,
        archivePending: this.pendingArchive.length,
      },
    );
  }

  private getOldestQueuedAt(): number | null {
    const activeQueuedAt = this.getOldestActiveQueuedAt();
    const archiveQueuedAt = this.pendingArchive[0]?.queuedAt;

    if (archiveQueuedAt === undefined) {
      return activeQueuedAt;
    }

    if (activeQueuedAt === null) {
      return archiveQueuedAt;
    }

    return Math.min(activeQueuedAt, archiveQueuedAt);
  }

  private getOldestActiveQueuedAt(): number | null {
    const firstPending = this.pendingActive.values().next().value;

    return firstPending?.queuedAt ?? null;
  }

  private getPendingCount(): number {
    return this.pendingActive.size + this.pendingArchive.length;
  }

  private hasPendingWork(): boolean {
    return this.getPendingCount() > 0;
  }

  private clearWorkerTimer(): void {
    if (!this.workerTimer) {
      return;
    }

    clearTimeout(this.workerTimer);
    this.workerTimer = null;
  }

  private logQueueState(): void {
    console.log(
      'Storage persistence queue',
      {
        activePending: this.pendingActive.size,
        archivePending: this.pendingArchive.length,
        totalPending: this.getPendingCount(),
        workerBusy: this.workerBusy,
        failedAttempts: this.failedAttempts,
        retryDelayMs: Math.max(0, this.retryAt - Date.now()),
        processedActiveSnapshots: this.processedActiveSnapshots,
        processedArchiveSnapshots: this.processedArchiveSnapshots,
      },
    );

    this.processedActiveSnapshots = 0;
    this.processedArchiveSnapshots = 0;
  }

  private logRuntimeState(): void {
    const currentEventLoopUtilization =
      performance.eventLoopUtilization();

    const eventLoopUtilization =
      performance.eventLoopUtilization(
        currentEventLoopUtilization,
        this.lastEventLoopUtilization,
      );

    this.lastEventLoopUtilization = currentEventLoopUtilization;

    const currentCpuUsage = process.cpuUsage();

    const cpuUsage = {
      user: currentCpuUsage.user - this.lastCpuUsage.user,
      system: currentCpuUsage.system - this.lastCpuUsage.system,
    };

    this.lastCpuUsage = currentCpuUsage;

    const toMilliseconds = (
      nanoseconds: number,
    ): number => nanoseconds / 1_000_000;

    console.log(
      'Storage runtime state',
      {
        eventLoopUtilization: Number(
          eventLoopUtilization.utilization.toFixed(3),
        ),

        eventLoopDelayMeanMs: Number(
          toMilliseconds(this.eventLoopDelay.mean).toFixed(2),
        ),

        eventLoopDelayMaxMs: Number(
          toMilliseconds(this.eventLoopDelay.max).toFixed(2),
        ),

        eventLoopDelayP99Ms: Number(
          toMilliseconds(
            this.eventLoopDelay.percentile(99),
          ).toFixed(2),
        ),

        cpuUserMs: Math.round(cpuUsage.user / 1_000),

        cpuSystemMs: Math.round(cpuUsage.system / 1_000),

        rssMb: Math.round(
          process.memoryUsage().rss / 1024 / 1024,
        ),

        heapTotalMb: Math.round(
          process.memoryUsage().heapTotal / 1024 / 1024,
        ),

        heapUsedMb: Math.round(
          process.memoryUsage().heapUsed / 1024 / 1024,
        ),

        externalMemoryMb: Math.round(
          process.memoryUsage().external / 1024 / 1024,
        ),

        arrayBufferMb: Math.round(
          process.memoryUsage().arrayBuffers / 1024 / 1024,
        ),

        workerBusy: this.workerBusy,
      },
    );
//
    this.eventLoopDelay.reset();
  }
}

export const storagePersistenceService = new StoragePersistenceService();
