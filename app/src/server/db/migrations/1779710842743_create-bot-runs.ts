import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('bot_runs', {
    id: {
      type: 'bigserial',
      primaryKey: true,
    },

    status: {
      type: 'text',
      notNull: true,
    },

    started_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },

    finished_at: {
      type: 'timestamptz',
    },

    error_text: {
      type: 'text',
    },
  });

  pgm.createTable('strategies', {
    id: 'id',

    code: {
      type: 'text',
      notNull: true,
      unique: true,
    },

    title: {
      type: 'text',
      notNull: true,
    },

    is_enabled: {
      type: 'boolean',
      notNull: true,
      default: true,
    },

    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createTable('strategy_runs', {
    id: {
      type: 'bigserial',
      primaryKey: true,
    },

    bot_run_id: {
      type: 'bigint',
      notNull: true,
      references: 'bot_runs(id)',
      onDelete: 'CASCADE',
    },

    strategy_id: {
      type: 'integer',
      notNull: true,
      references: 'strategies(id)',
      onDelete: 'RESTRICT',
    },

    status: {
      type: 'text',
      notNull: true,
    },

    started_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },

    finished_at: {
      type: 'timestamptz',
    },

    error_text: {
      type: 'text',
    },
  });

  pgm.createIndex('strategy_runs', ['bot_run_id']);
  pgm.createIndex('strategy_runs', ['strategy_id']);
  pgm.createIndex('strategy_runs', ['status']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('strategy_runs');
  pgm.dropTable('strategies');
  pgm.dropTable('bot_runs');
}
