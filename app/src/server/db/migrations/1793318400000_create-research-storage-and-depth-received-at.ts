import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pg: MigrationBuilder): Promise<void> {
  pg.createTable('research_storage', {
    market_name: { type: 'text', notNull: true },
    started_at: { type: 'bigint', notNull: true },
    ended_at: { type: 'bigint', notNull: true },
    num_of_items: { type: 'integer', notNull: true },
    data: { type: 'bytea', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pg.func('now()') },
  });
  pg.addConstraint('research_storage', 'research_storage_pk', {
    primaryKey: ['market_name', 'ended_at'],
  });
  pg.addConstraint('research_storage', 'research_storage_time_check', {
    check: 'ended_at >= started_at AND num_of_items > 0',
  });
  pg.createIndex('research_storage', ['market_name', 'num_of_items', 'ended_at'], {
    name: 'research_storage_repack_idx',
  });
  pg.createIndex('research_storage', 'num_of_items', {
    name: 'research_storage_num_of_items_idx',
  });

  // Store the last tick timestamp of each depth block alongside the binary
  // payload, which contains per-update timestamps in codec v1.0.
  pg.addColumn('order_book_depth_history', {
    received_at: { type: 'bigint' },
  });
  pg.sql(`UPDATE order_book_depth_history SET received_at = start_received_at`);
  pg.alterColumn('order_book_depth_history', 'received_at', { notNull: true });
  pg.createIndex('order_book_depth_history', ['market_name', 'received_at'], {
    name: 'order_book_depth_history_received_at_idx',
  });
}

export async function down(pg: MigrationBuilder): Promise<void> {
  pg.dropIndex('order_book_depth_history', 'order_book_depth_history_received_at_idx');
  pg.dropColumn('order_book_depth_history', 'received_at');
  pg.dropTable('research_storage');
}
