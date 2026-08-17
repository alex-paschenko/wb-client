// app/src/server/dao/market-candles.ts

import { writeFile } from 'node:fs/promises';

import type {
  MarketIndicatorValues,
} from '../../shared/types/market-indicators.js';
import type {
  MarketCandle,
} from '../../shared/types/market-statistics-storage.js';
import { q, type Sql, type TransactionSql } from '../db/client.js';
import type { SelectParams } from '../types/db.js';
import type {
  MarketCandleAddRow,
  MarketCandleIndicatorsChange,
  MarketCandleRemoveRow,
  MarketStatisticsPersistenceChanges
} from '../types/persistence.js';
import {
  buildUpsertSet,
  dbRow,
  toJsonObject
} from '../utilities/db-helpers.js';

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

interface UpdateIndicatorsData {
    marketName: string[];
    level: number[];
    startedAt: number[];
    endedAt: number[];
    indicators: string[];
}

const isAggregation = (
  changes: MarketCandleIndicatorsChange[]
): boolean => {
    const { marketName: firstMarketName } = changes[0];
    return changes
      .filter((ch) => ch.marketName === firstMarketName).length >= 10
      && changes.length > 2000;
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

  public async applyPersistenceChanges(
    changes: MarketStatisticsPersistenceChanges,
  ): Promise<void> {
    if (
      changes.newCandles.length === 0 &&
      changes.deleteBefore.length === 0 &&
      changes.indicatorChanged.length === 0
    ) {
      return;
    }

    await this.q.begin(async (trx) => {
      if (changes.newCandles.length > 0) {
        const startedAt = Date.now();

        await this.upsertCandles(changes.newCandles, trx);

        this.durationLogging(
          startedAt,
          'upsertCandles',
          { candles: changes.newCandles.length },
        );
      }

      if (changes.deleteBefore.length > 0) {
        const startedAt = Date.now();

        await this.deleteCandlesBefore(
          changes.deleteBefore,
          trx,
        );

        this.durationLogging(
          startedAt,
          'deleteCandlesBefore',
          { removals: changes.deleteBefore.length },
        );
      }

      if (changes.indicatorChanged.length > 0) {
        const startedAt = Date.now();

        await this.upsertIndicatorChanges(changes.indicatorChanged, trx);

        this.durationLogging(
          startedAt,
          'upsertIndicatorChanges',
          { changes: changes.indicatorChanged.length },
        );
      }
    });
  }

  private async upsertIndicatorChanges(
    changes: readonly MarketCandleIndicatorsChange[],
    query: Query,
  ): Promise<void> {
    if (changes.length === 0) {
      return;
    }

    const data: UpdateIndicatorsData =
      changes.reduce<UpdateIndicatorsData>(
        (acc, item) => {
          acc.marketName.push(item.marketName);
          acc.level.push(item.level);
          acc.startedAt.push(item.startedAt);
          acc.endedAt.push(item.endedAt);
          acc.indicators.push(JSON.stringify(item.indicators));

          return acc;
        },
        {
          marketName: [],
          level: [],
          startedAt: [],
          endedAt: [],
          indicators: []
        },
      );

    await query`
      MERGE INTO market_candle_indicators AS m
      USING (
        SELECT
          t.market_name,
          t.level,
          t.started_at,
          t.ended_at,
          t.indicators::jsonb AS indicators
        FROM unnest(
          ${data.marketName}::text[],
          ${data.level}::smallint[],
          ${data.startedAt}::bigint[],
          ${data.endedAt}::bigint[],
          ${data.indicators}::text[]
        ) AS t(
          market_name,
          level,
          started_at,
          ended_at,
          indicators
        )
      ) AS i
      ON (
        m.market_name = i.market_name
        AND m.level = i.level
        AND m.started_at = i.started_at
        AND m.ended_at = i.ended_at
      )

      WHEN MATCHED THEN
        UPDATE SET
          indicators = m.indicators || i.indicators

      WHEN NOT MATCHED THEN
        INSERT (
          market_name,
          level,
          started_at,
          ended_at,
          indicators
        )
        VALUES (
          i.market_name,
          i.level,
          i.started_at,
          i.ended_at,
          i.indicators
        );
    `;
  }

  private async explainUpsertIndicatorChanges(
    changes: readonly MarketCandleIndicatorsChange[],
    query: Query,
  ): Promise<void> {
    if (changes.length === 0) {
      return;
    }

    const enterTime = Date.now();

    let logData = '';

    const data: UpdateIndicatorsData =
      changes.reduce<UpdateIndicatorsData>(
        (acc, item) => {
          acc.marketName.push(item.marketName);
          acc.level.push(item.level);
          acc.startedAt.push(item.startedAt);
          acc.endedAt.push(item.endedAt);
          acc.indicators.push(JSON.stringify(item.indicators));

          return acc;
        },
        { marketName: [], level: [], startedAt: [], endedAt: [], indicators: [] },
      );

    const queryMStartTime = Date.now();

    const [resultM] = await query`
      EXPLAIN (
        ANALYZE,
        BUFFERS,
        WAL,
        VERBOSE,
        FORMAT JSON
      )
MERGE INTO market_candle_indicators AS m
USING (
  SELECT
    t.market_name,
    t.level,
    t.started_at,
    t.ended_at,
    t.indicators::jsonb AS indicators
  FROM unnest(
    ${data.marketName}::text[],
    ${data.level}::smallint[],
    ${data.startedAt}::bigint[],
    ${data.endedAt}::bigint[],
    ${data.indicators}::text[]
  ) AS t(
    market_name,
    level,
    started_at,
    ended_at,
    indicators
  )
) AS i
ON (
  m.market_name = i.market_name
  AND m.level = i.level
  AND m.started_at = i.started_at
  AND m.ended_at = i.ended_at
)

WHEN MATCHED THEN
  UPDATE SET
    indicators = m.indicators || i.indicators

WHEN NOT MATCHED THEN
  INSERT (
    market_name,
    level,
    started_at,
    ended_at,
    indicators
  )
  VALUES (
    i.market_name,
    i.level,
    i.started_at,
    i.ended_at,
    i.indicators
  );
    `;

    const queryIStartTime = Date.now();

    const [resultI] = await query`
      EXPLAIN (
        ANALYZE,
        BUFFERS,
        WAL,
        VERBOSE,
        FORMAT JSON
      )
  WITH incoming AS (
    SELECT
      t.market_name,
      t.level,
      t.started_at,
      t.ended_at,
      t.indicators::jsonb AS indicators
    FROM unnest (
      ${data.marketName}::text[],
      ${data.level}::smallint[],
      ${data.startedAt}::bigint[],
      ${data.endedAt}::bigint[],
      ${data.indicators}::text[]
    ) AS t (market_name, level, started_at, ended_at, indicators)
  ),

  upd AS (
    UPDATE market_candle_indicators m
    SET indicators = m.indicators || i.indicators
    FROM incoming i
    WHERE m.market_name = i.market_name
      AND m.level = i.level
      AND m.started_at = i.started_at
      AND m.ended_at = i.ended_at
    RETURNING m.market_name, m.level, m.started_at, m.ended_at
  )

  INSERT INTO market_candle_indicators
    (market_name, level, started_at, ended_at, indicators)
  SELECT
    i.market_name, i.level, i.started_at, i.ended_at, i.indicators
  FROM incoming i
  LEFT JOIN upd u ON
    u.market_name = i.market_name
    AND u.level = i.level
    AND u.started_at = i.started_at
    AND u.ended_at = i.ended_at
  WHERE u.market_name IS NULL
  ON CONFLICT (market_name, level, started_at, ended_at) DO NOTHING;

    `;
    const queryEndTime = Date.now();

    logData += '--- MERGE QUERY ---\n\n' + JSON.stringify(resultM, null, 4) +
      '\n\n--- INSERT QUERY ---\n\n' + JSON.stringify(resultI, null, 4);


      logData += `\n\n------------ STATISTICS: -----------------` +
        `\n Num of items: ${changes.length}, ` +
        `Query MERGE time: ${queryIStartTime - queryMStartTime}, ` +
        `Query INSERT time: ${queryEndTime - queryIStartTime}, ` +
        `Full time: ${queryEndTime - enterTime}\n`

      writeFile(
        `./logs/explain-upsert-indicators.txt-` +
            (new Intl.DateTimeFormat(
              'ru-RU',
              { day: '2-digit', month: '2-digit', year: '2-digit' }).format(Date.now())
            ) + '_' +
            (new Intl.DateTimeFormat(
              'ru-RU',
              { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(Date.now())
            ),
        logData,
        { encoding: 'utf8' },
      );

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