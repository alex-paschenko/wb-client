import { SECOND } from '../../shared/constants/time.js';
import type {
  MarketCandle,
  MarketSnapshot,
} from '../../shared/types/market-statistics-storage.js';
import { marketStatisticsDao } from '../dao/market-statistics.js';
import type {
  MarketCandleRemoveRow,
  MarketCandleRow,
} from '../dao/market-candles.js';
import type {
  MarketSnapshotRemoveRow,
  MarketSnapshotRow,
} from '../dao/market-snapshots.js';
import { SERVER_EVENT } from '../constants/events.js';
import type {
  MarketStatisticsPersistenceChangedEvent,
} from '../types/events.js';
import { eventBus } from './event-bus.js';

const FLUSH_INTERVAL = 5 * SECOND;

export class MarketStatisticsPersistenceBufferService {
  private snapshotsToAdd: MarketSnapshotRow[] = [];
  private candlesToAdd: MarketCandleRow[] = [];

  private readonly snapshotRemoveBounds = new Map<string, number>();
  private readonly candleRemoveBounds = new Map<string, number>();

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isFlushing = false;

  public start(): void {
    eventBus.on(
      SERVER_EVENT.marketStatisticsPersistenceChanged,
      (event) => this.handlePersistenceChanged(event),
    );

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL);
  }

  public async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flush();
  }

  private handlePersistenceChanged(
    event: MarketStatisticsPersistenceChangedEvent,
  ): void {
    const [
      snapshotChange,
      ...candleChanges
    ] = event.changes;

    if (!snapshotChange) {
      return;
    }

    this.snapshotsToAdd.push({
      marketName: event.marketName,
      ...(snapshotChange.item as MarketSnapshot),
    });

    this.updateSnapshotRemoveBound(
      event.marketName,
      snapshotChange.deleteBefore,
    );

    for (const [index, change] of candleChanges.entries()) {
      const level = index + 1;

      this.candlesToAdd.push({
        marketName: event.marketName,
        level,
        ...(change.item as MarketCandle),
      });

      this.updateCandleRemoveBound(
        event.marketName,
        level,
        change.deleteBefore,
      );
    }
  }

  private updateSnapshotRemoveBound(
    marketName: string,
    deleteBefore: number,
  ): void {
    const current = this.snapshotRemoveBounds.get(marketName);

    if (current === undefined || deleteBefore > current) {
      this.snapshotRemoveBounds.set(marketName, deleteBefore);
    }
  }

  private updateCandleRemoveBound(
    marketName: string,
    level: number,
    deleteBefore: number,
  ): void {
    const key = this.getCandleRemoveBoundKey(marketName, level);
    const current = this.candleRemoveBounds.get(key);

    if (current === undefined || deleteBefore > current) {
      this.candleRemoveBounds.set(key, deleteBefore);
    }
  }

  private async flush(): Promise<void> {
    if (this.isFlushing || !this.hasPendingChanges()) {
      return;
    }

    this.isFlushing = true;

    const snapshotsToAdd = this.snapshotsToAdd;
    const candlesToAdd = this.candlesToAdd;
    const snapshotRemoveRows = this.toSnapshotRemoveRows();
    const candleRemoveRows = this.toCandleRemoveRows();

    try {
      await marketStatisticsDao.refresh({
        snapshots: {
          toAdd: snapshotsToAdd,
          toRemove: snapshotRemoveRows,
        },
        candles: {
          toAdd: candlesToAdd,
          toRemove: candleRemoveRows,
        },
      });

      this.snapshotsToAdd = [];
      this.candlesToAdd = [];
      this.snapshotRemoveBounds.clear();
      this.candleRemoveBounds.clear();
    } catch (error) {
      console.error('Failed to flush market statistics persistence buffer', error);
    } finally {
      this.isFlushing = false;
    }
  }

  private hasPendingChanges(): boolean {
    return (
      this.snapshotsToAdd.length > 0 ||
      this.candlesToAdd.length > 0 ||
      this.snapshotRemoveBounds.size > 0 ||
      this.candleRemoveBounds.size > 0
    );
  }

  private toSnapshotRemoveRows(): MarketSnapshotRemoveRow[] {
    return [...this.snapshotRemoveBounds.entries()].map(
      ([marketName, timeThreshold]) => ({
        marketName,
        timeThreshold,
      }),
    );
  }

  private toCandleRemoveRows(): MarketCandleRemoveRow[] {
    return [...this.candleRemoveBounds.entries()].map(
      ([key, timeThreshold]) => {
        const [
          marketName,
          level,
        ] = this.parseCandleRemoveBoundKey(key);

        return {
          marketName,
          level,
          timeThreshold,
        };
      },
    );
  }

  private getCandleRemoveBoundKey(
    marketName: string,
    level: number,
  ): string {
    return `${marketName}:${level}`;
  }

  private parseCandleRemoveBoundKey(
    key: string,
  ): [marketName: string, level: number] {
    const [
      marketName,
      level,
    ] = key.split(':');

    return [
      marketName,
      Number(level),
    ];
  }
}

export const marketStatisticsPersistenceBufferService =
  new MarketStatisticsPersistenceBufferService();
