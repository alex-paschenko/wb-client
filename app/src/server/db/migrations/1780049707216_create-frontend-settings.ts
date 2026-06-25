import type { MigrationBuilder } from 'node-pg-migrate';

import { defaultFrontendSettings } from '../../../shared/constants/frontend-settings.js';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('frontend_settings', {
    user_id: {
      type: 'integer',
      primaryKey: true,
    },

    settings: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func(`'{}'::jsonb`),
    },

    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.sql(`
    insert into frontend_settings (
      user_id,
      settings
    )
    values (
      1,
      '${JSON.stringify(defaultFrontendSettings)}'::jsonb
    )
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('frontend_settings');
}
