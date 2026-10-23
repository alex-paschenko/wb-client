// app/src/server/db/migrations/1792411200000_add-storage-archive-num-of-items.ts

import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pg: MigrationBuilder): Promise<void> {
  pg.addColumn('storage_archive', {
    num_of_items: { type: 'integer' },
  });

  // Existing archive rows contain ticks v1.0 inside entire binary.
  // Their verified size is 47 + UTF-8 market name bytes + 16 per tick.
  pg.sql(`
    UPDATE storage_archive
    SET num_of_items = (
      octet_length(data) - 47
      - octet_length(convert_to(market_name, 'UTF8'))
    ) / 16
  `);

  pg.alterColumn('storage_archive', 'num_of_items', {
    notNull: true,
  });

  pg.addConstraint('storage_archive', 'storage_archive_num_of_items_check', {
    check: 'num_of_items > 0',
  });
}

export async function down(pg: MigrationBuilder): Promise<void> {
  pg.dropConstraint('storage_archive', 'storage_archive_num_of_items_check');
  pg.dropColumn('storage_archive', 'num_of_items');
}
