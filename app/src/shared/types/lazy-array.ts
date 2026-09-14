// app/src/shared/types/lazy-array.ts

export type ChangedInterval =
  [startFlatAscIndex: number, count: number];

export const changedIntervalIndexes = {
  startFlatAscIndex: 0,
  count: 1,
} as const;

export interface LazyArrayDeletedItems<T = unknown> {
  index: number;
  values: T[];
}
