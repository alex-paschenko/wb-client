// app/src/server/dao/market-candles.ts

import type {
  MarketIndicatorValues,
} from '../../shared/types/market-indicators.js';
import {
  MarketCandleIndicatorsChange
} from '../../shared/types/market-statistic-accessors.js';
import type {
  MarketCandle,
} from '../../shared/types/market-statistics-storage.js';
import { q, type Sql, type TransactionSql } from '../db/client.js';
import type { SelectParams } from '../types/db.js';
import { buildUpsertSet, dbRow } from '../utilities/db-helpers.js';

const MAX_INSERT_PARAMETERS = 60_000;
const MAX_INSERT_BATCH_SIZE = 1_000;
const INDICATOR_UPDATE_BATCH_SIZE = 2_000;
const DURATION_TRESHOLD = 100;

type Query = Sql | TransactionSql;

export interface MarketCandleRow extends MarketCandle {
  marketName: string;
  level: number;
  indicators: MarketIndicatorValues;
}

export interface MarketCandleAddRow extends MarketCandle {
  marketName: string;
  level: number;
}

export interface MarketCandleRemoveRow {
  marketName: string;
  level: number;
  timeThreshold: number;
}

export interface MarketCandlesAddedRemovedInput {
  toAdd: MarketCandleAddRow[];
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
          'acceleration', mc.acceleration,
          'startedAt', mc.started_at,
          'endedAt', mc.ended_at,
          'open', mc.open,
          'close', mc.close,
          'high', mc.high,
          'low', mc.low,
          'indicators', coalesce(mci.indicators, '{}'::jsonb)
        ) as candle
      from ${params?.from ?? query`market_candles`} as mc
        left join market_candle_indicators as mci
          on mci.market_name = mc.market_name
          and mci.level = mc.level
          and mci.started_at = mc.started_at
          and mci.ended_at = mc.ended_at
      ${params?.where ? query`where ${params.where}` : query``}
      ${params?.orderBy ? query`order by ${params.orderBy}` : query``}
      ${
        params?.limit === undefined
          ? query``
          : query`limit ${params.limit}`
      }
      ${
        params?.offset === undefined
          ? query``
          : query`offset ${params.offset}`
      }
    `;
  }

  public async getMarketNames(): Promise<string[]> {
    const rows =
      await this.q<{ marketName: string }[]>`
        select distinct mc.market_name as "marketName"
        from market_candles as mc
        order by mc.market_name asc
      `;

    return rows.map((row) => row.marketName);
  }

  public async getForStartup(
    marketName: string,
    maxLevel: number,
    maxLevelCutoff: number,
  ): Promise<MarketCandleRow[]> {
    const rows =
      await this.marketCandlesSelect(
        this.q,
        {
          where: this.q`
            mc.market_name = ${marketName}
            and (
              mc.level < ${maxLevel}
              or (
                mc.level = ${maxLevel}
                and mc.ended_at >= ${maxLevelCutoff}
              )
            )
          `,
          orderBy: this.q`
            mc.level asc,
            mc.started_at asc,
            mc.ended_at asc
          `,
        },
      );

    return rows.map(
      (row) => row.candle,
    );
  }

  public async getByMarketName(
    marketName: string,
  ): Promise<MarketCandleRow[]> {
    const rows =
      await this.marketCandlesSelect(
        this.q,
        {
          where: this.q`
            mc.market_name = ${marketName}
          `,
          orderBy: this.q`
            mc.level asc,
            mc.started_at asc,
            mc.ended_at asc
          `,
        },
      );

    return rows.map(
      (row) => row.candle,
    );
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

    const levelValues =
      levels.map(
        (item) => item.level,
      );

    const timeThresholds =
      levels.map(
        (item) => item.timeThreshold,
      );

    const rows =
      await this.marketCandlesSelect(
        this.q,
        {
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
        },
      );

    return rows.map(
      (row) => row.candle,
    );
  }

  public async getBeforeByLevel(
    level: number,
    timeThreshold: number,
    limit: number,
    offset: number,
  ): Promise<MarketCandleRow[]> {
    const rows =
      await this.marketCandlesSelect(
        this.q,
        {
          where: this.q`
            mc.level = ${level}
            and mc.ended_at < ${timeThreshold}
          `,
          orderBy: this.q`
            mc.market_name asc,
            mc.started_at asc,
            mc.ended_at asc
          `,
          limit,
          offset,
        },
      );

    return rows.map(
      (row) => row.candle,
    );
  }

  public async applyAddedRemovedBatch(
    batches: readonly MarketCandlesAddedRemovedInput[],
  ): Promise<void> {
    if (batches.length === 0) {
      return;
    }

    await this.q.begin(async (trx) => {
      for (const batch of batches) {
        if (batch.toAdd.length > 0) {
          const startedAt = Date.now();

          await this.upsertCandles(batch.toAdd, trx);

          this.durationLogging(
            startedAt,
            'insertMany',
            { candles: batch.toAdd.length },
          );
        }

        if (batch.toRemove.length > 0) {
          const startedAt = Date.now();

          await this.deleteCandlesBefore(batch.toRemove, trx);

          this.durationLogging(
            startedAt,
            'deleteOld',
            { candles: batch.toRemove.length },
          );
        }
      }
    });
  }

  public async upsertIndicatorChanges(
    changes: readonly MarketCandleIndicatorsChange[],
  ): Promise<void> {
    if (changes.length === 0) {
      return;
    }

    for (
      let offset = 0;
      offset < changes.length;
      offset += INDICATOR_UPDATE_BATCH_SIZE
    ) {
      const batch = changes.slice(
        offset,
        offset + INDICATOR_UPDATE_BATCH_SIZE,
      );

      const payload = JSON.stringify(batch);

      await this.q`
        insert into market_candle_indicators (
          market_name,
          level,
          started_at,
          ended_at,
          indicators
        )
        select
          changes_data."marketName",
          changes_data.level,
          changes_data."startedAt",
          changes_data."endedAt",
          changes_data.indicators
        from jsonb_to_recordset(
          (${payload}::text)::jsonb
        ) as changes_data(
          "marketName" text,
          level smallint,
          "startedAt" bigint,
          "endedAt" bigint,
          indicators jsonb
        )
        on conflict (
          market_name,
          level,
          started_at,
          ended_at
        )
        do update set
          indicators =
            market_candle_indicators.indicators ||
            excluded.indicators
      `;
    }
  }

  private durationLogging(
    startTimestamp: number,
    methodName: string,
    params: object | null = null,
  ) {
    const duration = Date.now() - startTimestamp;
    if (duration > DURATION_TRESHOLD) {
      const details = {
        ...(params ?? {}),
        duration,
      };
      console.log(`Too slow ${methodName}`, details);
    }
  }

  private async upsertCandles(
    candles: readonly MarketCandleAddRow[],
    query: Query = this.q,
  ): Promise<void> {
    if (candles.length === 0) {
      return;
    }

    const insertData = candles.map((candle) => dbRow({...candle}));
    const columns = Object.keys(insertData[0]);

    const updateColumns = columns.filter(
      (column) =>
        column !== 'market_name' &&
        column !== 'level' &&
        column !== 'started_at' &&
        column !== 'ended_at',
    );

    const updateSet = buildUpsertSet(query, updateColumns);

    const batchSize = Math.max(
      1,
      Math.min(
        MAX_INSERT_BATCH_SIZE,
        Math.floor(MAX_INSERT_PARAMETERS / columns.length),
      ),
    );

    for (
      let offset = 0;
      offset < insertData.length;
      offset += batchSize
    ) {
      await query`
        insert into market_candles
        ${query(insertData.slice(offset, offset + batchSize))}

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
  }

  private async deleteCandlesBefore(
    removals: MarketCandleRemoveRow[],
    query: Query = this.q,
  ): Promise<void> {
    if (removals.length === 0) {
      return;
    }

    const marketNames = removals.map(
      (item) => item.marketName,
    );

    const levels = removals.map(
      (item) => item.level,
    );

    const thresholds = removals.map(
      (item) => item.timeThreshold,
    );

    await query`
      delete from market_candles as mc
      using unnest(
        ${marketNames}::text[],
        ${levels}::int[],
        ${thresholds}::bigint[]
      ) as removal_bounds(
        market_name,
        level,
        time_threshold
      )
      where
        mc.market_name = removal_bounds.market_name
        and mc.level = removal_bounds.level
        and mc.ended_at < removal_bounds.time_threshold
    `;
  }
}

export const marketCandlesDao =
  new MarketCandlesDao(q);