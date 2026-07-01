import type { Sql, TransactionSql } from '../db/client';
import { q } from '../db/client.js';
import type { SelectParams } from '../types/db.js';
import {
  buildUpsertSet,
  dbRow,
} from '../utilities/db-helpers.js';
import type { MarketSnapshot } from '../../shared/types/market-statistics-storage.js';

type Query = Sql | TransactionSql;

export interface MarketSnapshotRow extends MarketSnapshot {
  marketName: string;
}

export interface MarketSnapshotRemoveRow {
  marketName: string;
  timeThreshold: number;
}

export interface RefreshMarketSnapshotsInput {
  toAdd: MarketSnapshotRow[];
  toRemove: MarketSnapshotRemoveRow[];
}

export class MarketSnapshotsDao {
  public constructor(
    private readonly q: Sql,
  ) {}

  private marketSnapshotsSelect(
    query: Query = this.q,
    params?: SelectParams,
  ) {
    return query<{ snapshot: MarketSnapshotRow }[]>`
      select
        json_build_object(
          'marketName', ms.market_name,
          'receivedAt', ms.received_at,
          'price', ms.price,
          'speed', ms.speed
        ) as snapshot
      from ${params?.from ?? query`market_snapshots`} as ms
      ${params?.where ? query`where ${params.where}` : query``}
      ${params?.orderBy ? query`order by ${params.orderBy}` : query``}
      ${params?.limit === undefined ? query`` : query`limit ${params.limit}`}
      ${params?.offset === undefined ? query`` : query`offset ${params.offset}`}
    `;
  }

  public async getByMarketName(
    marketName: string,
  ): Promise<MarketSnapshotRow[]> {
    const rows = await this.marketSnapshotsSelect(this.q, {
      where: this.q`ms.market_name = ${marketName}`,
      orderBy: this.q`ms.received_at asc`,
    });

    return rows.map((row) => row.snapshot);
  }

  public async refresh(
    input: RefreshMarketSnapshotsInput,
    query: Query = this.q,
  ): Promise<void> {
    if (input.toAdd.length > 0) {
      await this.insertMany(input.toAdd, query);
    }

    if (input.toRemove.length > 0) {
      await this.deleteOld(input.toRemove, query);
    }
  }

  public async getFrom(
    timeThreshold: number,
  ): Promise<MarketSnapshotRow[]> {
    const rows = await this.marketSnapshotsSelect(this.q, {
      where: this.q`ms.received_at >= ${timeThreshold}`,
      orderBy: this.q`ms.market_name asc, ms.received_at asc`,
    });

    return rows.map((row) => row.snapshot);
  }

  public async getBefore(
    timeThreshold: number,
  ): Promise<MarketSnapshotRow[]> {
    const rows = await this.marketSnapshotsSelect(this.q, {
      where: this.q`ms.received_at < ${timeThreshold}`,
      orderBy: this.q`ms.market_name asc, ms.received_at asc`,
    });

    return rows.map((row) => row.snapshot);
  }

  private async insertMany(
    snapshots: MarketSnapshotRow[],
    query: Query = this.q,
  ): Promise<void> {
    const insertData = snapshots.map((snapshot) => dbRow({ ...snapshot }));

    const updateColumns = Object.keys(insertData[0]).filter(
      (column) =>
        column !== 'market_name' &&
        column !== 'received_at',
    );

    const updateSet = buildUpsertSet(query, updateColumns);

    await query`
      insert into market_snapshots ${query(insertData)}

      on conflict (market_name, received_at)
      do update set
        ${updateSet}
    `;
  }

  private async deleteOld(
    removals: MarketSnapshotRemoveRow[],
    query: Query = this.q,
  ): Promise<void> {
    const marketNames = removals.map((removal) => removal.marketName);
    const timeThresholds = removals.map((removal) => removal.timeThreshold);

    await query`
      delete from market_snapshots as ms
      using unnest(
        ${marketNames}::text[],
        ${timeThresholds}::bigint[]
      ) as r(market_name, time_threshold)
      where
        ms.market_name = r.market_name
        and ms.received_at < r.time_threshold
    `;
  }
}

export const marketSnapshotsDao = new MarketSnapshotsDao(q);
