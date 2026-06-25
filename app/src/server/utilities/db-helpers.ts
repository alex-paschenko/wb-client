import { JSONValue, QueryFragment, Sql, TransactionSql } from '../db/client';

export type DbRowValue =
    | string
    | number
    | boolean
    | null
    | Date
    | undefined;

export type DbRow = Record<string, Exclude<DbRowValue, undefined>>;

export const nullifyUndefined = <T>(
  value: T | undefined,
): T | null => value ?? null;

export const toJsonObject = <
  T extends object,
>(
  value: T | undefined,
): JSONValue | null =>
  value
    ? value as JSONValue
    : null;

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function keysCamelToSnake<T extends Record<string, unknown>>(
  input: T,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      camelToSnake(key),
      value,
    ]),
  );
}

export function dbRow<T extends Record<string, DbRowValue>>(input: T): DbRow {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [camelToSnake(key), value]),
  ) as DbRow;
}

export function buildUpsertSet(
  q: Sql | TransactionSql,
  columns: string[],
): QueryFragment {
  return q.unsafe(
    columns
      .map((column) => `"${column}" = excluded."${column}"`)
      .join(', '),
  );
}
