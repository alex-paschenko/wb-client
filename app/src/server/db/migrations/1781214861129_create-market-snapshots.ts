import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pg: MigrationBuilder): Promise<void> {
  pg.createTable('market_snapshots', {
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

    price: {
      type: 'numeric',
      notNull: true,
    },

    speed: {
      type: 'numeric',
      notNull: true,
    },
  });

  pg.addConstraint('market_snapshots', 'market_snapshots_pk', {
    primaryKey: ['market_name', 'received_at'],
  });

  pg.createIndex('market_snapshots', ['received_at'], {
    name: 'market_snapshots_received_at_idx',
  });
}

export async function down(pg: MigrationBuilder): Promise<void> {
  pg.dropTable('market_snapshots');
}
