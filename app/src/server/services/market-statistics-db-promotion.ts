// app/src/server/services/market-statistics-db-promotion.ts
import {
  MARKET_STATISTICS_LEVEL_CONFIGS,
} from '../../shared/constants/market-statistics-config.js';

import type {
  MarketCandle,
  MarketSnapshot,
} from '../../shared/types/market-statistics-storage.js';

import {
  marketCandlesDao,
  type MarketCandleRow,
} from '../dao/market-candles.js';

import {
  marketSnapshotsDao,
  type MarketSnapshotRow,
} from '../dao/market-snapshots.js';

import {
  q,
} from '../db/client.js';
import { calculateCandlePrice, calculateSpeed } from '../utilities/price.js';
import { getMiddleTimestamp } from '../utilities/time.js';

type SourceItem = MarketSnapshotRow | MarketCandleRow;

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

      const promotedCount = level === 0
        ? await this.promoteSnapshots(cutoff, targetLevel, targetDuration)
        : await this.promoteCandles(
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

  private async promoteSnapshots(
    cutoff: number,
    targetLevel: number,
    targetDuration: number,
  ): Promise<number> {
    const snapshots = await marketSnapshotsDao.getBefore(cutoff);

    if (snapshots.length === 0) {
      return 0;
    }

    const candles = this.aggregateByMarket(
      snapshots,
      targetLevel,
      targetDuration,
      (items) => this.aggregateSnapshots(items as MarketSnapshotRow[]),
    );

    await q.begin(async (transaction) => {
      await marketCandlesDao.refresh(
        {
          toAdd: candles,
          toRemove: [],
        },
        transaction,
      );

      await marketSnapshotsDao.refresh(
        {
          toAdd: [],
          toRemove: this.createSnapshotRemovals(snapshots, cutoff),
        },
        transaction,
      );
    });

    return snapshots.length;
  }

  private async promoteCandles(
    sourceLevel: number,
    cutoff: number,
    targetLevel: number,
    targetDuration: number,
  ): Promise<number> {
    const candles = await marketCandlesDao.getBeforeByLevel(
      sourceLevel,
      cutoff,
    );

    if (candles.length === 0) {
      return 0;
    }

    const targetCandles = this.aggregateByMarket(
      candles,
      targetLevel,
      targetDuration,
      (items) => this.aggregateCandles(items as MarketCandleRow[]),
    );

    await q.begin(async (transaction) => {
      await marketCandlesDao.refresh(
        {
          toAdd: targetCandles,
          toRemove: this.createCandleRemovals(
            candles,
            sourceLevel,
            cutoff,
          ),
        },
        transaction,
      );
    });

    return candles.length;
  }

  private aggregateByMarket<TItem extends SourceItem>(
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
        const itemStartedAt = this.getItemStartedAt(item);

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

  private groupByMarket<TItem extends SourceItem>(
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

  private aggregateSnapshots(
    snapshots: MarketSnapshotRow[],
  ): MarketCandle {
    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];

    let high = first.price;
    let low = first.price;

    for (const snapshot of snapshots) {
      high = Math.max(high, snapshot.price);
      low = Math.min(low, snapshot.price);
    }

    const startedAt = first.receivedAt;
    const endedAt = last.receivedAt;
    const receivedAt = getMiddleTimestamp(startedAt, endedAt);

    const open = first.price;
    const close = last.price;

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

  private createSnapshotRemovals(
    snapshots: MarketSnapshotRow[],
    cutoff: number,
  ) {
    return [...new Set(snapshots.map((snapshot) => snapshot.marketName))]
      .map((marketName) => ({
        marketName,
        timeThreshold: cutoff,
      }));
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

  private getItemStartedAt(item: SourceItem): number {
    return 'startedAt' in item
      ? item.startedAt
      : item.receivedAt;
  }
}

export const marketStatisticsDbPromotionService =
  new MarketStatisticsDbPromotionService();
