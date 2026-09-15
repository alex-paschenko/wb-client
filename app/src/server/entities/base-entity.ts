// app/src/server/entities/base-entity.ts

import type { LazyArray } from '../../shared/utilities/lazy-array.js';
import type { ChangedInterval } from '../../shared/types/lazy-array.js';
import { changedIntervalIndexes } from '../../shared/types/lazy-array.js';
import type { StorageAccessors } from '../../shared/types/storage.js';
import type { EntityDesriptor } from '../../shared/types/storage-entities.js';
import type {
  Entity,
  EntityAffectedRange,
} from '../types/entities.js';
import type {
  StorageEntityKind,
} from '../../shared/constants/storage-entities.js';

export abstract class BaseEntity<T> implements Entity<T> {
  public readonly descriptor: EntityDesriptor<T>;
  public readonly dependencies: readonly string[];

  protected constructor(
    descriptor: EntityDesriptor<T>,
    dependencies: readonly string[] = [],
  ) {
    this.descriptor = Object.freeze({ ...descriptor });
    this.dependencies = Object.freeze([...dependencies]);
  }

  public abstract calculate(
    accessors: StorageAccessors,
    marketName: string,
  ): void;

  public removeMarket(_marketName: string): void {}

  protected getValues(accessors: StorageAccessors): LazyArray<T> {
    return this.getEntityValues<T>(
      accessors,
      this.descriptor.kind,
      this.descriptor.name,
    );
  }

  protected getEntityValues<TValue>(
    accessors: StorageAccessors,
    kind: StorageEntityKind,
    name: string,
  ): LazyArray<TValue> {
    const values = accessors[kind][name];

    if (!values) {
      throw new Error(
        `Entity "${kind}/${name}" accessor not found`,
      );
    }

    return values as LazyArray<TValue>;
  }

  protected getChangedIntervals(
    accessors: StorageAccessors,
  ): ChangedInterval[] {
    const intervals = [
      ...this.getValues(accessors).getTransitoryChanges(),
    ];

    for (const dependency of this.dependencies) {
      intervals.push(
        ...this.getEntityValues(
          accessors,
          this.descriptor.kind,
          dependency,
        ).getTransitoryChanges(),
      );
    }

    return this.mergeChangedIntervals(intervals);
  }

  protected buildFiniteAffectedRanges(
    accessors: StorageAccessors,
    affectedValuesCount: number,
  ): EntityAffectedRange[] {
    const values = this.getValues(accessors);

    if (values.length === 0 || affectedValuesCount <= 0) {
      return [];
    }

    const ranges = this.getChangedIntervals(accessors).map((interval) => {
      const startIndex =
        interval[changedIntervalIndexes.startFlatAscIndex];

      const count = interval[changedIntervalIndexes.count];

      return {
        startIndex,
        endIndex: Math.min(
          values.length - 1,
          startIndex + count + affectedValuesCount - 2,
        ),
      };
    });

    return this.mergeAffectedRanges(ranges);
  }

  protected buildInfiniteAffectedRanges(
    accessors: StorageAccessors,
  ): EntityAffectedRange[] {
    const values = this.getValues(accessors);
    const intervals = this.getChangedIntervals(accessors);

    if (values.length === 0 || intervals.length === 0) {
      return [];
    }

    return [{
      startIndex:
        intervals[0][changedIntervalIndexes.startFlatAscIndex],
      endIndex: values.length - 1,
    }];
  }

  private mergeChangedIntervals(
    intervals: readonly ChangedInterval[],
  ): ChangedInterval[] {
    if (intervals.length === 0) {
      return [];
    }

    const sorted = [...intervals].sort(
      (a, b) =>
        a[changedIntervalIndexes.startFlatAscIndex] -
        b[changedIntervalIndexes.startFlatAscIndex],
    );

    const result: ChangedInterval[] = [];

    for (const interval of sorted) {
      const start = interval[changedIntervalIndexes.startFlatAscIndex];
      const count = interval[changedIntervalIndexes.count];

      if (count <= 0) {
        continue;
      }

      const end = start + count - 1;
      const previous = result.at(-1);

      if (!previous) {
        result.push([start, count]);
        continue;
      }

      const previousStart =
        previous[changedIntervalIndexes.startFlatAscIndex];

      const previousCount =
        previous[changedIntervalIndexes.count];

      const previousEnd = previousStart + previousCount - 1;

      if (start > previousEnd + 1) {
        result.push([start, count]);
        continue;
      }

      previous[changedIntervalIndexes.count] =
        Math.max(previousEnd, end) - previousStart + 1;
    }

    return result;
  }

  private mergeAffectedRanges(
    ranges: readonly EntityAffectedRange[],
  ): EntityAffectedRange[] {
    const result: EntityAffectedRange[] = [];

    for (const range of ranges) {
      const previous = result.at(-1);

      if (!previous || range.startIndex > previous.endIndex + 1) {
        result.push({ ...range });
        continue;
      }

      previous.endIndex = Math.max(previous.endIndex, range.endIndex);
    }

    return result;
  }
}
