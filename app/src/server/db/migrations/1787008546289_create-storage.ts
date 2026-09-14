// app/src/server/db/migrations/1787008546289_create-storage.ts

import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pg: MigrationBuilder): Promise<void> {
  pg.createTable('storage_alive', {
    market_name: {
      type: 'text',
      primaryKey: true,
      notNull: true,
    },

    started_at: {
      type: 'bigint',
      notNull: true,
    },

    ended_at: {
      type: 'bigint',
      notNull: true,
    },

    data: {
      type: 'bytea',
      notNull: true,
    },

    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pg.func('now()'),
    },

    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pg.func('now()'),
    },
  });

  pg.addConstraint(
    'storage_alive',
    'storage_alive_time_check',
    {
      check: 'ended_at >= started_at',
    },
  );

  pg.createTable('storage_archive', {
    market_name: {
      type: 'text',
      notNull: true,
    },

    started_at: {
      type: 'bigint',
      notNull: true,
    },

    ended_at: {
      type: 'bigint',
      notNull: true,
    },

    data: {
      type: 'bytea',
      notNull: true,
    },

    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pg.func('now()'),
    },

    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pg.func('now()'),
    },
  });

  pg.addConstraint(
    'storage_archive',
    'storage_archive_pk',
    {
      primaryKey: [
        'market_name',
        'ended_at',
      ],
    },
  );

  pg.addConstraint(
    'storage_archive',
    'storage_archive_time_check',
    {
      check: 'ended_at >= started_at',
    },
  );
}

export async function down(pg: MigrationBuilder): Promise<void> {
  pg.dropTable('storage_archive');
  pg.dropTable('storage_alive');
}
