// app/src/server/db/migrations/1792972800000_extend-strategy-state-history.ts

import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pg: MigrationBuilder): Promise<void> {
  pg.addColumns('strategy_state_history', {
    kind: { type: 'smallint', notNull: true, default: 0 },
    error_code: { type: 'integer' },
    stock: { type: 'double precision' },
    money: { type: 'double precision' },
  });
  
}

export async function down(pg: MigrationBuilder): Promise<void> {
  pg.dropColumns('strategy_state_history', [
    'kind', 'error_code', 'stock', 'money',
  ]);
}
