import type { Sql } from '../db/client';
import { q } from '../db/client.js';
import {
  marketCandlesDao,
  type RefreshMarketCandlesInput,
} from './market-candles.js';
import {
  marketSnapshotsDao,
  type RefreshMarketSnapshotsInput,
} from './market-snapshots.js';

export interface RefreshMarketStatisticsInput {
  snapshots: RefreshMarketSnapshotsInput;
  candles: RefreshMarketCandlesInput;
}

export class MarketStatisticsDao {
  public constructor(
    private readonly q: Sql,
  ) {}

  public async refresh(
    input: RefreshMarketStatisticsInput,
  ): Promise<void> {
    await this.q.begin(async (trx) => {
      await marketSnapshotsDao.refresh(input.snapshots, trx);
      await marketCandlesDao.refresh(input.candles, trx);
    });
  }
}

export const marketStatisticsDao = new MarketStatisticsDao(q);
