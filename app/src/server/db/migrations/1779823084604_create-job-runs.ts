import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('job_runs', {
    id: {
      type: 'bigserial',
      primaryKey: true,
    },

    job_name: {
      type: 'text',
      notNull: true,
    },

    status: {
      type: 'text',
      notNull: true,
    },

    result: {
      type: 'jsonb',
    },

    error_text: {
      type: 'text',
    },

    started_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },

    finished_at: {
      type: 'timestamptz',
    },

    duration_ms: {
      type: 'integer',
    },
  });

  pgm.createIndex('job_runs', ['job_name', 'started_at']);
  pgm.createIndex('job_runs', ['status']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('job_runs');
}
