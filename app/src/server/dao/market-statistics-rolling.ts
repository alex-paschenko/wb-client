import type { Sql } from '../db/client.js';
import { q } from '../db/client.js';
import type { SelectParams } from '../types/db.js';
import { buildUpsertSet, dbRow } from '../utilities/db-helpers.js';
import type {
  MarketRollingStatistics,
  MarketRollingStatisticsByMarket,
} from '../../shared/types/market-statistics-rolling.js';

export interface MarketStatisticsRollingRow extends MarketRollingStatistics {
  marketName: string;
}

export class MarketStatisticsRollingDao {
  public constructor(
    private readonly q: Sql,
  ) {}

  private marketRollingStatisticsSelect(
    params?: SelectParams,
  ) {
    return this.q<{ rolling: MarketStatisticsRollingRow }[]>`
      select
        json_build_object(
          'marketName', mrs.market_name,
          'receivedAt', mrs.received_at,
          'open', mrs.open,
          'close', mrs.close,
          'high', mrs.high,
          'low', mrs.low,
          'stockVolume', mrs.stock_volume,
          'moneyVolume', mrs.money_volume
        ) as rolling
      from ${params?.from ?? this.q`market_rolling_statistics`} as mrs
      ${params?.where ? this.q`where ${params.where}` : this.q``}
      ${params?.orderBy ? this.q`order by ${params.orderBy}` : this.q``}
      ${params?.limit === undefined ? this.q`` : this.q`limit ${params.limit}`}
      ${params?.offset === undefined ? this.q`` : this.q`offset ${params.offset}`}
    `;
  }

  public async insertMany(
    input: MarketStatisticsRollingRow[],
  ): Promise<void> {
    if (input.length === 0) {
      return;
    }

    const q = this.q;

    const insertData = input.map((row) => dbRow({ ...row }));

    const updateColumns = Object.keys(insertData[0]).filter(
      (column) =>
        column !== 'market_name' &&
        column !== 'received_at',
    );

    const updateSet = buildUpsertSet(q, updateColumns);

    await q`
      insert into market_rolling_statistics ${q(insertData)}

      on conflict (market_name, received_at)
      do update set
        ${updateSet}
    `;
  }

  public async getLatestRowsByMarket(): Promise<MarketStatisticsRollingRow[]> {
    const rows = await this.marketRollingStatisticsSelect({
      from: this.q`
        (
          select distinct on (market_name)
            *
          from market_rolling_statistics
          order by market_name, received_at desc
        )
      `,
      orderBy: this.q`mrs.market_name asc`,
    });

    return rows.map((row) => row.rolling);
  }
}

export const marketStatisticsRollingDao =
  new MarketStatisticsRollingDao(q);
