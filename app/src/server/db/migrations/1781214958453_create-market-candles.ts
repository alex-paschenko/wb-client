import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pg: MigrationBuilder): Promise<void> {
  pg.createTable('market_candles', {
    market_name: {
      type: 'text',
      notNull: true,
      references: 'markets(name)',
      onDelete: 'CASCADE',
    },

    level: {
      type: 'smallint',
      notNull: true,
    },

    received_at: {
      type: 'bigint',
      notNull: true,
    },

    price: {
      type: 'numeric',
      notNull: true,
    },

    speed: {
      type: 'numeric',
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
  });

  pg.addConstraint('market_candles', 'market_candles_pk', {
    primaryKey: [
      'market_name',
      'level',
      'started_at',
      'ended_at',
    ],
  });

  pg.createIndex('market_candles', ['market_name', 'level', 'ended_at'], {
    name: 'market_candles_market_level_ended_at_idx',
  });

  pg.createIndex('market_candles', ['level', 'received_at'], {
    name: 'market_candles_level_received_at_idx',
  });
}

export async function down(pg: MigrationBuilder): Promise<void> {
  pg.dropTable('market_candles');
}
