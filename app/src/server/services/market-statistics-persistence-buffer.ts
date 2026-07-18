import {
  monitorEventLoopDelay,
  performance,
} from 'node:perf_hooks';

import { SECONDS } from '../../shared/constants/time.js';

import {
  marketCandlesDao,
  type MarketCandleIndicatorsChange,
  type MarketCandleRemoveRow,
  type MarketCandleRow,
  type RefreshMarketCandlesInput,
} from '../dao/market-candles.js';

import {
  SERVER_EVENT,
} from '../constants/events.js';

import type {
  MarketStatisticsPersistenceChangedEvent,
} from '../types/events.js';

import { eventBus } from './event-bus.js';

const isCpuProfiling =
  process.execArgv.some(
    (arg) => arg.startsWith('--cpu-prof'),
  );

const WORKER_INTERVAL = 10;

const MARKETS_PER_BATCH = 20;

const MAX_INDICATOR_CHANGES_PER_BATCH = 2_000;

const QUEUE_MONITOR_INTERVAL = 10 * SECONDS;

const EVENT_LOOP_MONITOR_INTERVAL = 10 * SECONDS;

const STOP_POLL_INTERVAL = 10;

interface PendingMarketPersistence {
  readonly marketName: string;

  readonly toAdd:
    Map<string, MarketCandleRow>;

  readonly toChange:
    Map<string, MarketCandleIndicatorsChange>;

  readonly removeBounds:
    Map<number, number>;
}

interface PersistenceBatchItem {
  marketName: string;
  input: RefreshMarketCandlesInput;
}

export class MarketStatisticsPersistenceBufferService {

  private readonly pendingByMarket =
    new Map<
      string,
      PendingMarketPersistence
    >();

  private workerTimer:
    ReturnType<typeof setInterval> | null = null;

  private queueMonitorTimer:
    ReturnType<typeof setInterval> | null = null;

  private eventLoopMonitorTimer:
    ReturnType<typeof setInterval> | null = null;

  private workerBusy = false;

  private processedMarkets = 0;

  private processedCandles = 0;

  private processedIndicatorChanges = 0;

  private readonly eventLoopDelay =
    monitorEventLoopDelay({
      resolution: 20,
    });

  private lastEventLoopUtilization =
    performance.eventLoopUtilization();

  private lastCpuUsage =
    process.cpuUsage();

  private unsubscribePersistenceChanged:
    (() => void) | null = null;

  public start(): void {
    if (this.unsubscribePersistenceChanged) {
      return;
    }

    this.unsubscribePersistenceChanged =
      eventBus.on(
        SERVER_EVENT.marketStatisticsPersistenceChanged,
        (event) => {
          this.handlePersistenceChanged(
            event,
          );
        },
      );

    this.workerTimer =
      setInterval(() => {
        void this.workerTick();
      }, WORKER_INTERVAL);

    this.queueMonitorTimer =
      setInterval(() => {
        this.logQueueState();
      }, QUEUE_MONITOR_INTERVAL);

    this.eventLoopDelay.enable();

    this.lastEventLoopUtilization =
      performance.eventLoopUtilization();

    this.lastCpuUsage =
      process.cpuUsage();

    this.eventLoopMonitorTimer =
      setInterval(() => {
        this.logRuntimeState();
      }, EVENT_LOOP_MONITOR_INTERVAL);
  }

  public async stop(): Promise<void> {
    this.unsubscribePersistenceChanged?.();
    this.unsubscribePersistenceChanged = null;

    if (this.workerTimer) {
      clearInterval(
        this.workerTimer,
      );

      this.workerTimer = null;
    }

    if (this.queueMonitorTimer) {
      clearInterval(
        this.queueMonitorTimer,
      );

      this.queueMonitorTimer = null;
    }

    if (this.eventLoopMonitorTimer) {
      clearInterval(
        this.eventLoopMonitorTimer,
      );

      this.eventLoopMonitorTimer = null;
    }

    this.eventLoopDelay.disable();

    while (
      this.workerBusy ||
      this.pendingByMarket.size > 0
    ) {
      if (!this.workerBusy) {
        await this.workerTick();
      }

      await new Promise<void>((resolve) => {
        setTimeout(
          resolve,
          STOP_POLL_INTERVAL,
        );
      });
    }
  }

    private handlePersistenceChanged(
    event: MarketStatisticsPersistenceChangedEvent,
  ): void {
    const pending =
      this.getOrCreatePending(
        event.marketName,
      );

    this.enqueueCandles(
      pending,
      event,
    );

    this.enqueueIndicatorChanges(
      pending,
      event,
    );

    this.enqueueRemovals(
      pending,
      event,
    );
  }

  private enqueueCandles(
    pending: PendingMarketPersistence,
    event: MarketStatisticsPersistenceChangedEvent,
  ): void {

    for (
      const [
        level,
        change,
      ]
      of event.changes.entries()
    ) {

      const candle: MarketCandleRow = {
        marketName:
          event.marketName,

        level,

        ...change.item,

        indicators:
          level === 0
            ? event.latestIndicators
            : {},
      };

      pending.toAdd.set(
        this.getCandleKey(
          candle,
        ),
        candle,
      );
    }
  }

  private enqueueIndicatorChanges(
    pending: PendingMarketPersistence,
    event: MarketStatisticsPersistenceChangedEvent,
  ): void {
    for (const change of event.indicatorChanges) {
      const key = this.getIndicatorChangeKey(
        change,
      );

      const existing =
        pending.toChange.get(key);

      if (!existing) {
        pending.toChange.set(key, {
          marketName: event.marketName,
          ...change,
        });

        continue;
      }

      pending.toChange.set(key, {
        ...existing,
        indicators: {
          ...existing.indicators,
          ...change.indicators,
        },
      });
    }
  }

  private enqueueRemovals(
    pending: PendingMarketPersistence,
    event: MarketStatisticsPersistenceChangedEvent,
  ): void {

    for (
      const [
        level,
        change,
      ]
      of event.changes.entries()
    ) {

      const current =
        pending.removeBounds.get(
          level,
        );

      if (
        current === undefined ||
        change.deleteBefore > current
      ) {
        pending.removeBounds.set(
          level,
          change.deleteBefore,
        );
      }
    }
  }

  private getCandleKey(
    candle: MarketCandleRow,
  ): string {

    return [
      candle.level,
      candle.startedAt,
      candle.endedAt,
    ].join(':');
  }

  private getIndicatorChangeKey(
    change: Pick<
      MarketCandleIndicatorsChange,
      'level' | 'startedAt' | 'endedAt'
    >,
  ): string {
    return [
      change.level,
      change.startedAt,
      change.endedAt,
    ].join(':');
  }

  private async workerTick(): Promise<void> {
    if (
      this.workerBusy ||
      this.pendingByMarket.size === 0
    ) {
      return;
    }

    this.workerBusy = true;

    const batch = this.takeNextBatch();

    try {
      if (batch.length === 0) {
        return;
      }

      const inputs = batch.map(
        (item) => item.input,
      );

      const candlesCount = inputs.reduce(
        (total, input) =>
          total + input.toAdd.length,
        0,
      );

      const indicatorChangesCount = inputs.reduce(
        (total, input) =>
          total + input.toChange.length,
        0,
      );

      const startedAt = Date.now();

      if (isCpuProfiling) {

        await new Promise<void>((resolve) => {
          setTimeout(() => {
            const dur = Date.now() - startedAt;
            if (dur > 100) {
              console.log(`Simulated DAO duration: `, dur);
            }
            resolve();
          }, 10);
        });
      } else {
        await marketCandlesDao.refreshBatch(
          inputs,
        );
      }

      const duration =
        Date.now() - startedAt;

      this.processedMarkets +=
        batch.length;

      this.processedCandles +=
        candlesCount;

      this.processedIndicatorChanges +=
        indicatorChangesCount;

      if (duration >= 100) {
        console.warn(
          'Slow persistence worker batch',
          {
            duration,
            markets: batch.length,
            candles: candlesCount,
            indicatorChanges:
              indicatorChangesCount,
          },
        );
      }
    } catch (error) {
      this.restoreBatch(batch);

      console.error(
        'Persistence worker failed',
        error,
      );
    } finally {
      this.workerBusy = false;
    }
  }

  private restoreBatch(
    batch: readonly PersistenceBatchItem[],
  ): void {
    for (const item of batch) {
      const current =
        this.getOrCreatePending(
          item.marketName,
        );

      for (const candle of item.input.toAdd) {
        const key =
          this.getCandleKey(candle);

        /*
        * A newer queued candle version wins over the failed one.
        */
        if (!current.toAdd.has(key)) {
          current.toAdd.set(
            key,
            candle,
          );
        }
      }

      for (
        const change
        of item.input.toChange
      ) {
        const key =
          this.getIndicatorChangeKey(
            change,
          );

        const newer =
          current.toChange.get(key);

        if (!newer) {
          current.toChange.set(
            key,
            change,
          );

          continue;
        }

        current.toChange.set(key, {
          ...change,
          indicators: {
            ...change.indicators,
            ...newer.indicators,
          },
        });
      }

      for (
        const removal
        of item.input.toRemove
      ) {
        const currentThreshold =
          current.removeBounds.get(
            removal.level,
          );

        if (
          currentThreshold === undefined ||
          removal.timeThreshold >
            currentThreshold
        ) {
          current.removeBounds.set(
            removal.level,
            removal.timeThreshold,
          );
        }
      }

      /*
      * Retried work goes to the end of the queue.
      */
      this.pendingByMarket.delete(
        item.marketName,
      );

      this.pendingByMarket.set(
        item.marketName,
        current,
      );
    }
  }

  private getOrCreatePending(
    marketName: string,
  ): PendingMarketPersistence {
    let pending =
      this.pendingByMarket.get(marketName);

    if (pending) {
      return pending;
    }

    pending = {
      marketName,
      toAdd: new Map(),
      toChange: new Map(),
      removeBounds: new Map(),
    };

    this.pendingByMarket.set(
      marketName,
      pending,
    );

    return pending;
  }

  private takeNextBatch():
    PersistenceBatchItem[] {
    const batch: PersistenceBatchItem[] = [];

    let indicatorChangesCount = 0;

    const marketNames = [
      ...this.pendingByMarket.keys(),
    ];

    for (const marketName of marketNames) {
      if (
        batch.length >= MARKETS_PER_BATCH ||
        indicatorChangesCount >=
          MAX_INDICATOR_CHANGES_PER_BATCH
      ) {
        break;
      }

      const pending =
        this.pendingByMarket.get(marketName);

      if (!pending) {
        continue;
      }

      const remainingIndicatorCapacity =
        MAX_INDICATOR_CHANGES_PER_BATCH -
        indicatorChangesCount;

      const toChange =
        this.takeIndicatorChanges(
          pending,
          remainingIndicatorCapacity,
        );

      const toAdd = [
        ...pending.toAdd.values(),
      ];

      pending.toAdd.clear();

      /*
      * Removals are deferred until all currently queued indicator
      * changes for this market have been extracted.
      */
      const toRemove =
        pending.toChange.size === 0
          ? this.takeRemoveRows(pending)
          : [];

      if (
        toAdd.length === 0 &&
        toChange.length === 0 &&
        toRemove.length === 0
      ) {
        if (this.isPendingEmpty(pending)) {
          this.pendingByMarket.delete(
            marketName,
          );
        }

        continue;
      }

      batch.push({
        marketName,
        input: {
          toAdd,
          toChange,
          toRemove,
        },
      });

      indicatorChangesCount +=
        toChange.length;

      if (this.isPendingEmpty(pending)) {
        this.pendingByMarket.delete(
          marketName,
        );
      } else {
        /*
        * Move a partially drained market to the end of the queue
        * so other markets are not starved.
        */
        this.pendingByMarket.delete(
          marketName,
        );

        this.pendingByMarket.set(
          marketName,
          pending,
        );
      }
    }

    return batch;
  }

  private takeIndicatorChanges(
    pending: PendingMarketPersistence,
    limit: number,
  ): MarketCandleIndicatorsChange[] {
    if (limit <= 0) {
      return [];
    }

    const result:
      MarketCandleIndicatorsChange[] = [];

    for (
      const [key, change]
      of pending.toChange
    ) {
      result.push(change);
      pending.toChange.delete(key);

      if (result.length >= limit) {
        break;
      }
    }

    return result;
  }

  private takeRemoveRows(
    pending: PendingMarketPersistence,
  ): MarketCandleRemoveRow[] {
    const result:
      MarketCandleRemoveRow[] = [];

    for (
      const [level, timeThreshold]
      of pending.removeBounds
    ) {
      result.push({
        marketName: pending.marketName,
        level,
        timeThreshold,
      });
    }

    pending.removeBounds.clear();

    return result;
  }

  private isPendingEmpty(
    pending: PendingMarketPersistence,
  ): boolean {
    return (
      pending.toAdd.size === 0 &&
      pending.toChange.size === 0 &&
      pending.removeBounds.size === 0
    );
  }

  private logQueueState(): void {

    let candles = 0;
    let indicatorChanges = 0;
    let removeBounds = 0;


    for (
      const pending
      of this.pendingByMarket.values()
    ) {

      candles +=
        pending.toAdd.size;

      indicatorChanges +=
        pending.toChange.size;

      removeBounds +=
        pending.removeBounds.size;
    }

    console.log(
      'Market statistics persistence queue',
      {
        markets:
          this.pendingByMarket.size,

        candles,

        indicatorChanges,

        candleRemoveBounds:
          removeBounds,

        workerBusy:
          this.workerBusy,

        processedMarkets:
          this.processedMarkets,

        processedCandles:
          this.processedCandles,

        processedIndicatorChanges:
          this.processedIndicatorChanges,
      },
    );

    this.processedMarkets = 0;
    this.processedCandles = 0;
    this.processedIndicatorChanges = 0;
  }

  private logRuntimeState(): void {

    const eventLoopUtilization =
      performance.eventLoopUtilization(
        this.lastEventLoopUtilization,
      );

    this.lastEventLoopUtilization =
      performance.eventLoopUtilization();

    const cpuUsage =
      process.cpuUsage(
        this.lastCpuUsage,
      );

    this.lastCpuUsage =
      process.cpuUsage();

    const toMilliseconds = (
      nanoseconds: number,
    ): number =>
      nanoseconds /
      1_000_000;

    console.log(
      'Market statistics runtime state',
      {
        eventLoopUtilization:
          Number(
            eventLoopUtilization
              .utilization
              .toFixed(3),
          ),

        eventLoopDelayMeanMs:
          Number(
            toMilliseconds(
              this.eventLoopDelay.mean,
            ).toFixed(2),
          ),

        eventLoopDelayMaxMs:
          Number(
            toMilliseconds(
              this.eventLoopDelay.max,
            ).toFixed(2),
          ),

        eventLoopDelayP99Ms:
          Number(
            toMilliseconds(
              this.eventLoopDelay.percentile(99),
            ).toFixed(2),
          ),

        cpuUserMs:
          Math.round(
            cpuUsage.user / 1_000,
          ),

        cpuSystemMs:
          Math.round(
            cpuUsage.system / 1_000,
          ),

        rssMb:
          Math.round(
            process.memoryUsage().rss /
            1024 /
            1024,
          ),

        heapUsedMb:
          Math.round(
            process.memoryUsage().heapUsed /
            1024 /
            1024,
          ),

        workerBusy:
          this.workerBusy,
      },
    );

    this.eventLoopDelay.reset();
  }
}

export const
  marketStatisticsPersistenceBufferService =
    new MarketStatisticsPersistenceBufferService();