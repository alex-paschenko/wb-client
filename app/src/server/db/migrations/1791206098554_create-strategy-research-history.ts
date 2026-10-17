// app/src/server/db/migrations/1791206098554_create-strategy-research-history.ts

import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pg: MigrationBuilder): Promise<void> {
  pg.sql(`
    CREATE TABLE order_receipts (
      received_at bigint NOT NULL,
      receipt_sequence bigint NOT NULL,
      market_name text NOT NULL,
      strategy_name text NOT NULL,
      client_order_id bigint NOT NULL,
      order_kind text NOT NULL,
      paper_trading boolean NOT NULL,
      data bytea NOT NULL,
      PRIMARY KEY (received_at, receipt_sequence)
    );
    CREATE INDEX order_receipts_strategy_idx
      ON order_receipts (strategy_name, market_name, received_at);

    CREATE TABLE order_book_depth_history (
      market_name text NOT NULL,
      start_received_at bigint NOT NULL,
      depth_sequence bigint NOT NULL,
      data bytea NOT NULL,
      PRIMARY KEY (start_received_at, depth_sequence)
    );
    CREATE INDEX order_book_depth_history_market_idx
      ON order_book_depth_history
      (market_name, start_received_at, depth_sequence);

    CREATE TABLE strategy_state_history (
      market_name text NOT NULL,
      strategy_name text NOT NULL,
      received_at bigint NOT NULL,
      state_sequence bigint NOT NULL,
      state text NOT NULL,
      PRIMARY KEY (received_at, state_sequence)
    );
    CREATE INDEX strategy_state_history_strategy_idx
      ON strategy_state_history
      (strategy_name, market_name, received_at, state_sequence);
  `);
}

export async function down(pg: MigrationBuilder): Promise<void> {
  pg.sql(`
    DROP TABLE strategy_state_history;
    DROP TABLE order_book_depth_history;
    DROP TABLE order_receipts;
  `);
}
