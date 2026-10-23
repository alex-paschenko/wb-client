// app/src/server/db/migrations/1792562400000_add-storage-archive-repack-index.ts

import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pg: MigrationBuilder): Promise<void> {
  pg.createIndex(
    'storage_archive',
    ['market_name', 'num_of_items', 'ended_at'],
    { name: 'storage_archive_repack_idx' },
  );
}

export async function down(pg: MigrationBuilder): Promise<void> {
  pg.dropIndex('storage_archive', 'storage_archive_repack_idx');
}
