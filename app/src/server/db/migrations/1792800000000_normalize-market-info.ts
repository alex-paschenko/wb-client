// app/src/server/db/migrations/1792800000000_normalize-market-info.ts

import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pg: MigrationBuilder): void => {
  pg.addColumns('markets', {
    tick_size: { type: 'numeric' },
    step_size: { type: 'numeric' },
    delisted_at: { type: 'bigint' },
    is_tradfi_futures: { type: 'boolean', notNull: true, default: false },
  });

  // Existing market fees were stored as percentage numbers.
  pg.sql(`
    UPDATE markets SET
      maker_fee = maker_fee / 100,
      taker_fee = taker_fee / 100,
      max_total = COALESCE(max_total, 0),
      is_collateral = COALESCE(is_collateral, false),
      is_tradfi_futures = (type = 'tradfiFutures')
  `);
  pg.alterColumn('markets', 'max_total', { notNull: true });
  pg.alterColumn('markets', 'is_collateral', { notNull: true });
  pg.addConstraint('markets', 'markets_step_sizes_check', {
    check: '(tick_size IS NULL OR tick_size > 0) AND ' +
      '(step_size IS NULL OR step_size > 0)',
  });
  pg.addConstraint('markets', 'markets_delisted_at_check', {
    check: 'delisted_at IS NULL OR delisted_at >= 0',
  });
};

export const down = (pg: MigrationBuilder): void => {
  pg.dropConstraint('markets', 'markets_delisted_at_check');
  pg.dropConstraint('markets', 'markets_step_sizes_check');
  pg.alterColumn('markets', 'is_collateral', { notNull: false });
  pg.alterColumn('markets', 'max_total', { notNull: false });
  pg.sql(`
    UPDATE markets SET
      maker_fee = maker_fee * 100,
      taker_fee = taker_fee * 100
  `);
  pg.dropColumns('markets', [
    'tick_size', 'step_size', 'delisted_at', 'is_tradfi_futures',
  ]);
};
