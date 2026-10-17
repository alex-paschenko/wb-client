// app/src/server/db/migrations/1791206098553_create-order-id-sequence.ts

import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pg: MigrationBuilder): Promise<void> {
  pg.sql('CREATE SEQUENCE public.order_id_seq AS bigint CACHE 1 NO CYCLE');
}

export async function down(pg: MigrationBuilder): Promise<void> {
  pg.sql('DROP SEQUENCE IF EXISTS public.order_id_seq');
}
