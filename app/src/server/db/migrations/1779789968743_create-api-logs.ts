import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('api_logs', {
    id: {
      type: 'bigserial',
      primaryKey: true,
    },

    service: {
      type: 'text',
      notNull: true,
    },

    endpoint: {
      type: 'text',
      notNull: true,
    },

    method: {
      type: 'text',
      notNull: true,
    },

    status_code: {
      type: 'integer',
    },

    request_body: {
      type: 'jsonb',
    },

    response_body: {
      type: 'jsonb',
    },

    error_text: {
      type: 'text',
    },

    duration_ms: {
      type: 'integer',
    },

    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('api_logs', [
    'service',
    'created_at',
  ]);

  pgm.createIndex('api_logs', [
    'endpoint',
  ]);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('api_logs');
}
