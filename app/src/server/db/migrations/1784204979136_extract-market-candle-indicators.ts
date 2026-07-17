// app/src/server/db/migrations/1784200000000_extract-market-candle-indicators.ts
import type {
  MigrationBuilder,
} from 'node-pg-migrate';

export async function up(
  pg: MigrationBuilder,
): Promise<void> {
  pg.createTable('market_candle_indicators', {
    market_name: {
      type: 'text',
      notNull: true,
    },
    level: {
      type: 'smallint',
      notNull: true,
    },
    started_at: {
      type: 'bigint',
      notNull: true,
    },
    ended_at: {
      type: 'bigint',
      notNull: true,
    },
    indicators: {
      type: 'jsonb',
      notNull: true,
    },
  });

  pg.addConstraint(
    'market_candle_indicators',
    'market_candle_indicators_pk',
    {
      primaryKey: [
        'market_name',
        'level',
        'started_at',
        'ended_at',
      ],
    },
  );

  pg.sql(`
    alter table market_candle_indicators
    add constraint market_candle_indicators_candle_fk
    foreign key (
      market_name,
      level,
      started_at,
      ended_at
    )
    references market_candles (
      market_name,
      level,
      started_at,
      ended_at
    )
    on delete cascade
  `);

  pg.sql(`
    insert into market_candle_indicators (
      market_name,
      level,
      started_at,
      ended_at,
      indicators
    )
    select
      market_name,
      level,
      started_at,
      ended_at,
      indicators
    from market_candles
    where indicators <> '{}'::jsonb
  `);

  pg.dropColumns(
    'market_candles',
    [
      'indicators',
    ],
  );

  pg.dropTable(
    'market_snapshots',
  );

  pg.sql(`
    analyze market_candles
  `);

  pg.sql(`
    analyze market_candle_indicators
  `);
}

export async function down(
  pg: MigrationBuilder,
): Promise<void> {
  pg.addColumns('market_candles', {
    indicators: {
      type: 'jsonb',
    },
  });

  pg.sql(`
    update market_candles as mc
    set indicators =
      coalesce(
        mci.indicators,
        '{}'::jsonb
      )
    from market_candle_indicators as mci
    where
      mci.market_name = mc.market_name
      and mci.level = mc.level
      and mci.started_at = mc.started_at
      and mci.ended_at = mc.ended_at
  `);

  pg.sql(`
    update market_candles
    set indicators = '{}'::jsonb
    where indicators is null
  `);

  pg.alterColumn(
    'market_candles',
    'indicators',
    {
      type: 'jsonb',
      notNull: true,
    },
  );

  pg.dropTable(
    'market_candle_indicators',
  );

  pg.sql(`
    analyze market_candles
  `);
}
