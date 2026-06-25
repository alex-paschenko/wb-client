// 003_create_market_rolling_statistics.ts
import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pg: MigrationBuilder): Promise<void> {
  pg.createTable('market_rolling_statistics', {
    market_name: {
      type: 'text',
      notNull: true,
      references: 'markets(name)',
      onDelete: 'CASCADE',
    },

    received_at: {
      type: 'bigint',
      notNull: true,
    },

    open: {
      type: 'numeric',
      notNull: true,
    },

    close: {
      type: 'numeric',
      notNull: true,
    },

    high: {
      type: 'numeric',
      notNull: true,
    },

    low: {
      type: 'numeric',
      notNull: true,
    },

    stock_volume: {
      type: 'numeric',
      notNull: true,
    },

    money_volume: {
      type: 'numeric',
      notNull: true,
    },
  });

  pg.addConstraint(
    'market_rolling_statistics',
    'market_rolling_statistics_pk',
    {
      primaryKey: ['market_name', 'received_at'],
    },
  );

  pg.createIndex('market_rolling_statistics', ['received_at'], {
    name: 'market_rolling_statistics_received_at_idx',
  });
}

export async function down(pg: MigrationBuilder): Promise<void> {
  pg.dropTable('market_rolling_statistics');
}
