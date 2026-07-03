import { SECOND } from '../../shared/constants/time.js';
import type {
  MarketCandle,
} from '../../shared/types/market-statistics-storage.js';
import {
  marketCandlesDao,
  type MarketCandleRemoveRow,
  type MarketCandleRow,
} from '../dao/market-candles.js';
import { SERVER_EVENT } from '../constants/events.js';
import type {
  MarketStatisticsPersistenceChangedEvent,
} from '../types/events.js';
import { eventBus } from './event-bus.js';

const FLUSH_INTERVAL = 5 * SECOND;

export class MarketStatisticsPersistenceBufferService {
  private candlesToAdd: MarketCandleRow[] = [];
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
    const candleChanges = event.changes;

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

    const candlesToAdd = this.candlesToAdd;
    const candleRemoveRows = this.toCandleRemoveRows();

    try {
    await marketCandlesDao.refresh({
        toAdd: candlesToAdd,
        toRemove: candleRemoveRows,
      });

      this.candlesToAdd = [];
      this.candleRemoveBounds.clear();
    } catch (error) {
      console.error('Failed to flush market statistics persistence buffer', error);
    } finally {
      this.isFlushing = false;
    }
  }

  private hasPendingChanges(): boolean {
    return (
      this.candlesToAdd.length > 0 ||
      this.candleRemoveBounds.size > 0
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
