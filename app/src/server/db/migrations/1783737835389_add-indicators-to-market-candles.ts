// app/src/server/db/migrations/1783737835389_add-indicators-to-market-candles.ts
import type {
  MigrationBuilder,
} from 'node-pg-migrate';

export async function up(
  pg: MigrationBuilder,
): Promise<void> {
  pg.addColumns('market_candles', {
    indicators: {
      type: 'jsonb',
    },
  });

  pg.sql(`
    update market_candles
    set indicators = '{}'::jsonb
    where indicators is null
  `);

  pg.alterColumn('market_candles', 'indicators', {
    type: 'jsonb',
    notNull: true,
  });
}

export async function down(
  pg: MigrationBuilder,
): Promise<void> {
  pg.dropColumns('market_candles', [
    'indicators',
  ]);
}
