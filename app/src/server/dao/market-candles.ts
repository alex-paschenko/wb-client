import type { Sql, TransactionSql } from '../db/client';
import { q } from '../db/client.js';
import type { SelectParams } from '../types/db.js';
import {
  buildUpsertSet,
  dbRow,
} from '../utilities/db-helpers.js';
import type { MarketCandle } from '../../shared/types/market-statistics-storage.js';

type Query = Sql | TransactionSql;

export interface MarketCandleRow extends MarketCandle {
  marketName: string;
  level: number;
}

export interface MarketCandleRemoveRow {
  marketName: string;
  level: number;
  timeThreshold: number;
}

export interface RefreshMarketCandlesInput {
  toAdd: MarketCandleRow[];
  toRemove: MarketCandleRemoveRow[];
}

export class MarketCandlesDao {
  public constructor(
    private readonly q: Sql,
  ) {}

  private marketCandlesSelect(
    query: Query = this.q,
    params?: SelectParams,
  ) {
    return query<{ candle: MarketCandleRow }[]>`
      select
        json_build_object(
          'marketName', mc.market_name,
          'level', mc.level,
          'receivedAt', mc.received_at,
          'price', mc.price,
          'speed', mc.speed,
          'startedAt', mc.started_at,
          'endedAt', mc.ended_at,
          'open', mc.open,
          'close', mc.close,
          'high', mc.high,
          'low', mc.low
        ) as candle
      from ${params?.from ?? query`market_candles`} as mc
      ${params?.where ? query`where ${params.where}` : query``}
      ${params?.orderBy ? query`order by ${params.orderBy}` : query``}
      ${params?.limit === undefined ? query`` : query`limit ${params.limit}`}
      ${params?.offset === undefined ? query`` : query`offset ${params.offset}`}
    `;
  }

  public async getByMarketName(
    marketName: string,
  ): Promise<MarketCandleRow[]> {
    const rows = await this.marketCandlesSelect(this.q, {
      where: this.q`mc.market_name = ${marketName}`,
      orderBy: this.q`mc.level asc, mc.started_at asc, mc.ended_at asc`,
    });

    return rows.map((row) => row.candle);
  }

  public async getFromByLevels(
    levels: {
      level: number;
      timeThreshold: number;
    }[],
  ): Promise<MarketCandleRow[]> {
    if (levels.length === 0) {
      return [];
    }

    const levelValues = levels.map((item) => item.level);
    const timeThresholds = levels.map((item) => item.timeThreshold);

    const rows = await this.marketCandlesSelect(this.q, {
      where: this.q`
        exists (
          select 1
          from unnest(
            ${levelValues}::int[],
            ${timeThresholds}::bigint[]
          ) as bounds(level, time_threshold)
          where
            bounds.level = mc.level
            and mc.ended_at >= bounds.time_threshold
        )
      `,
      orderBy: this.q`
        mc.market_name asc,
        mc.level asc,
        mc.started_at asc,
        mc.ended_at asc
      `,
    });

    return rows.map((row) => row.candle) ?? [];
  }

  public async getBeforeByLevel(
    level: number,
    timeThreshold: number,
  ): Promise<MarketCandleRow[]> {
    const rows = await this.marketCandlesSelect(this.q, {
      where: this.q`
        mc.level = ${level}
        and mc.ended_at < ${timeThreshold}
      `,
      orderBy: this.q`
        mc.market_name asc,
        mc.started_at asc,
        mc.ended_at asc
      `,
    });

    return rows.map((row) => row.candle);
  }

  public async refresh(
    input: RefreshMarketCandlesInput,
    query: Query = this.q,
  ): Promise<void> {
    if (input.toAdd.length > 0) {
      await this.insertMany(input.toAdd, query);
    }

    if (input.toRemove.length > 0) {
      await this.deleteOld(input.toRemove, query);
    }
  }

  private async insertMany(
    candles: MarketCandleRow[],
    query: Query = this.q,
  ): Promise<void> {
    const insertData = candles.map((candle) => dbRow({ ...candle }));

    const updateColumns = Object.keys(insertData[0]).filter(
      (column) =>
        column !== 'market_name' &&
        column !== 'level' &&
        column !== 'started_at' &&
        column !== 'ended_at',
    );

    const updateSet = buildUpsertSet(query, updateColumns);

    await query`
      insert into market_candles ${query(insertData)}

      on conflict (
        market_name,
        level,
        started_at,
        ended_at
      )
      do update set
        ${updateSet}
    `;
  }

  private async deleteOld(
    removals: MarketCandleRemoveRow[],
    query: Query = this.q,
  ): Promise<void> {
    const marketNames = removals.map((removal) => removal.marketName);
    const levels = removals.map((removal) => removal.level);
    const timeThresholds = removals.map((removal) => removal.timeThreshold);

    await query`
      delete from market_candles as mc
      using unnest(
        ${marketNames}::text[],
        ${levels}::int[],
        ${timeThresholds}::bigint[]
      ) as r(market_name, level, time_threshold)
      where
        mc.market_name = r.market_name
        and mc.level = r.level
        and mc.ended_at < r.time_threshold
    `;
  }
}

export const marketCandlesDao = new MarketCandlesDao(q);
