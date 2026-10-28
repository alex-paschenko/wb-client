// app/src/server/db/migrations/1793145600000_fix-market-tradfi-column.ts

import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pg: MigrationBuilder): void => {
  pg.renameColumn(
    'markets',
    'is_tradfi_futures',
    'is_trad_fi_futures',
  );
};

export const down = (pg: MigrationBuilder): void => {
  pg.renameColumn(
    'markets',
    'is_trad_fi_futures',
    'is_tradfi_futures',
  );
};
