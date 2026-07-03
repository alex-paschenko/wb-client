// app/src/server/services/market-statistics-restore.ts

import {
  MARKET_STATISTICS_LEVEL_CONFIGS,
} from '../../shared/constants/market-statistics-config.js';

import type {
  MarketCandle,
} from '../../shared/types/market-statistics-storage.js';

import { SERVER_EVENT } from '../constants/events.js';

import {
  marketCandlesDao,
  type MarketCandleRow,
} from '../dao/market-candles.js';
import { MarketStatisticsRestoredMarketData } from '../types/events.js';

import { eventBus } from './event-bus.js';

export class MarketStatisticsRestoreService {
  private timeTreshold: number[] = [];

  public async start(): Promise<void> {
    const now = Date.now();

    this.timeTreshold = MARKET_STATISTICS_LEVEL_CONFIGS.reduce(
      (acc, configEntry) => {
        acc.interval += configEntry.interval;
        acc.result.push(now - acc.interval);
        return acc;
      },
      { interval: 0, result: [] as number[] },
    ).result;

    const itemsByMarket: MarketStatisticsRestoredMarketData = {};

    await this.restoreCandles(now, itemsByMarket);

    eventBus.emit(SERVER_EVENT.marketStatisticsRestored, {
      itemsByMarket,
    });
  }

  private async restoreCandles(
    now: number,
    itemsByMarket: MarketStatisticsRestoredMarketData,
  ): Promise<void> {
    const candleLevels = MARKET_STATISTICS_LEVEL_CONFIGS
      .map((configEntry, level) => ({
        level,
        timeThreshold: this.timeTreshold[level],
      }));

    try {
      const rows = await marketCandlesDao.getFromByLevels(candleLevels);

      for (const row of rows) {
        const market = this.getOrCreateMarketData(
          itemsByMarket,
          row.marketName,
        );

        market[row.level].push(this.toCandle(row));
      }
    } catch (error) {
      console.error('Failed to restore market candles from DB', error);
    }
  }

  private getOrCreateMarketData(
    itemsByMarket: MarketStatisticsRestoredMarketData,
    marketName: string,
  ): MarketCandle[][] {
    itemsByMarket[marketName] ??=
      MARKET_STATISTICS_LEVEL_CONFIGS.map(() => []);

    return itemsByMarket[marketName];
  }

  private toCandle(
    row: MarketCandleRow,
  ): MarketCandle {
    return {
      receivedAt: row.receivedAt,
      price: row.price,
      speed: row.speed,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      open: row.open,
      close: row.close,
      high: row.high,
      low: row.low,
    };
  }
}

export const marketStatisticsRestoreService =
  new MarketStatisticsRestoreService();