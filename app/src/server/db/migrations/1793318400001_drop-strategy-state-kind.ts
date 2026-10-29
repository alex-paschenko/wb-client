// app/src/server/db/migrations/1793318400001_drop-strategy-state-kind.ts

import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pg: MigrationBuilder): Promise<void> {
  pg.dropColumn('strategy_state_history', 'kind');
}

export async function down(pg: MigrationBuilder): Promise<void> {
  pg.addColumn('strategy_state_history', {
    kind: { type: 'smallint', notNull: true, default: 0 },
  });
}
