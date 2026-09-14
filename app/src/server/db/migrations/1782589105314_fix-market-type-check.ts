// app/src/server/db/migrations/1782589105314_fix-market-type-check.ts

import type {
  MigrationBuilder,
} from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint(
    'markets',
    'markets_type_check',
  );

  pgm.addConstraint(
    'markets',
    'markets_type_check',
    {
      check: "type in ('spot', 'futures', 'tradfiFutures')",
    },
  );
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint(
    'markets',
    'markets_type_check',
  );

  pgm.addConstraint(
    'markets',
    'markets_type_check',
    {
      check: "type in ('spot', 'futures')",
    },
  );
};
