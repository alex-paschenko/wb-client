// app/src/shared/types/lazy-array.ts

export type ChangedInterval =
  [startFlatAscIndex: number, count: number];

export const changedIntervalIndexes = {
  startFlatAscIndex: 0,
  count: 1,
} as const;

export interface LazyArrayResults<T> {
  readonly name: string;
  readonly changedIntervals: ChangedInterval[];
  readonly cache: T[];
}

export type Boundaries = [startedAt: number, endedAt: number];
