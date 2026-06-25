// src/server/services/market-statistics-rolling.ts
import { MINUTE } from '../../shared/constants/time.js';
import type {
  MarketRollingStatistics,
  MarketRollingStatisticsByMarket,
} from '../../shared/types/market-statistics-rolling.js';
import { SERVER_EVENT } from '../constants/events.js';
import {
  marketStatisticsRollingDao,
  type MarketStatisticsRollingRow,
} from '../dao/market-statistics-rolling.js';
import type {
  MarketRollingTickReceivedEvent,
} from '../types/events.js';
import { eventBus } from './event-bus.js';

const SAVE_ROLLING_INTERVAL = 1 * MINUTE;

export class MarketStatisticsRollingService {
  private rollingStatisticsByMarket: MarketRollingStatisticsByMarket = {};
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private isSaving = false;

  public async start(): Promise<void> {
    const rows = await marketStatisticsRollingDao.getLatestRowsByMarket();

    this.rollingStatisticsByMarket = this.toRollingStatisticsByMarket(rows);

    eventBus.on(
      SERVER_EVENT.marketRollingTickReceived,
      (event) => this.handleRollingTickReceived(event),
    );

    this.saveTimer = setInterval(() => {
      void this.saveCurrent();
    }, SAVE_ROLLING_INTERVAL);
  }

  public async stop(): Promise<void> {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }

    await this.saveCurrent();
  }

  public getAll(): MarketRollingStatisticsByMarket {
    return this.rollingStatisticsByMarket;
  }

  public getByMarketName(
    marketName: string,
  ): MarketRollingStatistics | undefined {
    return this.rollingStatisticsByMarket[marketName];
  }

  private handleRollingTickReceived(
    event: MarketRollingTickReceivedEvent,
  ): void {
    this.rollingStatisticsByMarket[event.marketName] =
      event.rollingStatistics;

    eventBus.emit(SERVER_EVENT.marketRollingUpdated, {
      rollingStatisticsByMarket: this.rollingStatisticsByMarket,
    });
  }

  private async saveCurrent(): Promise<void> {
    if (this.isSaving) {
      return;
    }

    const rows = this.toRows(this.rollingStatisticsByMarket);

    if (rows.length === 0) {
      return;
    }

    this.isSaving = true;

    try {
      await marketStatisticsRollingDao.insertMany(rows);
    } catch (error) {
      console.error('Failed to save market statistics rolling data', error);
    } finally {
      this.isSaving = false;
    }
  }

  private toRows(
    rollingStatisticsByMarket: MarketRollingStatisticsByMarket,
  ): MarketStatisticsRollingRow[] {
    return Object.entries(rollingStatisticsByMarket).map(
      ([marketName, statistics]) => ({
        marketName,
        ...statistics,
      }),
    );
  }

  private toRollingStatisticsByMarket(
    rows: MarketStatisticsRollingRow[],
  ): MarketRollingStatisticsByMarket {
    return Object.fromEntries(
      rows.map((row) => [
        row.marketName,
        {
          receivedAt: row.receivedAt,
          open: row.open,
          close: row.close,
          high: row.high,
          low: row.low,
          stockVolume: row.stockVolume,
          moneyVolume: row.moneyVolume,
        },
      ]),
    );
  }
}

export const marketStatisticsRollingService =
  new MarketStatisticsRollingService();
