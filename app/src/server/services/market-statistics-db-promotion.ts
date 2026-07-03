// app/src/server/services/market-statistics-db-promotion.ts
import {
  MARKET_STATISTICS_LEVEL_CONFIGS,
} from '../../shared/constants/market-statistics-config.js';

import type {
  MarketCandle,
} from '../../shared/types/market-statistics-storage.js';

import {
  marketCandlesDao,
  type MarketCandleRow,
} from '../dao/market-candles.js';
import { calculateCandlePrice, calculateSpeed } from '../utilities/price.js';
import { getMiddleTimestamp } from '../utilities/time.js';

const BATCH_SIZE = 3000;

export class MarketStatisticsDbPromotionService {
  public async run(): Promise<void> {
    const now = Date.now();
    let retentionDepth = 0;

    console.log('Market statistics DB promotion started');

    for (
      let level = 0;
      level < MARKET_STATISTICS_LEVEL_CONFIGS.length - 1;
      level += 1
    ) {
      retentionDepth += MARKET_STATISTICS_LEVEL_CONFIGS[level].interval;

      const cutoff = now - retentionDepth;
      const targetLevel = level + 1;
      const targetDuration =
        MARKET_STATISTICS_LEVEL_CONFIGS[targetLevel].duration;

      const promotedCount = await this.promoteCandles(
        level,
        cutoff,
        targetLevel,
        targetDuration,
      );

      console.log('Market statistics DB promotion level done', {
        sourceLevel: level,
        targetLevel,
        cutoff,
        promotedCount,
      });
    }

    console.log('Market statistics DB promotion finished');
  }

  private async promoteCandles(
    sourceLevel: number,
    cutoff: number,
    targetLevel: number,
    targetDuration: number,
  ): Promise<number> {
    let candles: MarketCandleRow[];
    let count = 0;

    do {
      candles = await marketCandlesDao.getBeforeByLevel(
        sourceLevel,
        cutoff,
        BATCH_SIZE,
        count,
      );

      count += candles.length;
      if (candles.length === 0) {
        break;
      }

      const targetCandles = this.aggregateByMarket(
        candles,
        targetLevel,
        targetDuration,
        (items) => this.aggregateCandles(items as MarketCandleRow[]),
      );

      await marketCandlesDao.refresh(
        {
          toAdd: targetCandles,
          toRemove: this.createCandleRemovals(
            candles,
            sourceLevel,
            cutoff,
          ),
        },
      );
    } while (candles.length > 0);

    return count;
  }

  private aggregateByMarket<TItem extends MarketCandleRow>(
    items: TItem[],
    targetLevel: number,
    targetDuration: number,
    aggregate: (items: TItem[]) => MarketCandle,
  ): MarketCandleRow[] {
    const result: MarketCandleRow[] = [];
    const itemsByMarket = this.groupByMarket(items);

    for (const [marketName, marketItems] of itemsByMarket) {
      let bucket: TItem[] = [];
      let bucketStartedAt: number | null = null;

      for (const item of marketItems) {
        const itemStartedAt = item.startedAt;

        if (bucketStartedAt === null) {
          bucketStartedAt = itemStartedAt;
        }

        if (
          bucket.length > 0 &&
          itemStartedAt - bucketStartedAt >= targetDuration
        ) {
          result.push({
            ...aggregate(bucket),
            marketName,
            level: targetLevel,
          });

          bucket = [];
          bucketStartedAt = itemStartedAt;
        }

        bucket.push(item);
      }

      if (bucket.length > 0) {
        result.push({
          ...aggregate(bucket),
          marketName,
          level: targetLevel,
        });
      }
    }

    return result;
  }

  private groupByMarket<TItem extends MarketCandleRow>(
    items: TItem[],
  ): Map<string, TItem[]> {
    const result = new Map<string, TItem[]>();

    for (const item of items) {
      const existing = result.get(item.marketName);

      if (existing) {
        existing.push(item);
      } else {
        result.set(item.marketName, [item]);
      }
    }

    return result;
  }

  private aggregateCandles(
    candles: MarketCandleRow[],
  ): MarketCandle {
    const first = candles[0];
    const last = candles[candles.length - 1];

    let high = first.high;
    let low = first.low;

    for (const candle of candles) {
      high = Math.max(high, candle.high);
      low = Math.min(low, candle.low);
    }

    const startedAt = first.startedAt;
    const endedAt = last.endedAt;
    const receivedAt = getMiddleTimestamp(startedAt, endedAt);

    const open = first.open;
    const close = last.close;

    return {
      receivedAt,
      price: calculateCandlePrice(open, close, high, low),
      speed: calculateSpeed(
        first.receivedAt,
        first.price,
        last.receivedAt,
        last.price,
      ),
      startedAt,
      endedAt,
      open,
      close,
      high,
      low,
    };
  }

  private createCandleRemovals(
    candles: MarketCandleRow[],
    sourceLevel: number,
    cutoff: number,
  ) {
    return [...new Set(candles.map((candle) => candle.marketName))]
      .map((marketName) => ({
        marketName,
        level: sourceLevel,
        timeThreshold: cutoff,
      }));
  }
}

export const marketStatisticsDbPromotionService =
  new MarketStatisticsDbPromotionService();
