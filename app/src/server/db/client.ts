import postgres from 'postgres';

export type QueryFragment = postgres.Fragment;
export type Sql = postgres.Sql;
export type JSONValue = postgres.JSONValue;
export type TransactionSql = postgres.TransactionSql;

export const q = postgres(process.env.DATABASE_URL!, {
  max: 10,
});
