// app/src/shared/utilities/changed-intervals.ts

import type { ChangedInterval } from '../types/lazy-array.js';

export class ChangedIntervals {
  private values: ChangedInterval[] = [];

  public constructor(private itemsCount: number) {
    if (!Number.isSafeInteger(itemsCount) || itemsCount < 0) {
      throw new TypeError(
        `Invalid ChangedIntervals size: ${itemsCount}`,
      );
    }
  }

  public get length(): number {
    return this.itemsCount;
  }

  public get intervals(): readonly ChangedInterval[] {
    return this.values;
  }

  public set(index: number): void {
    this.validateIndex(index);

    const values = this.values;

    for (let i = 0; i < values.length; i++) {
      const interval = values[i];
      const start = interval[0];
      const end = start + interval[1];

      if (index < start - 1) {
        values.splice(i, 0, [index, 1]);
        return;
      }

      if (index === start - 1) {
        interval[0] = index;
        interval[1]++;

        const previous = values[i - 1];

        if (previous && previous[0] + previous[1] === index) {
          previous[1] += interval[1];
          values.splice(i, 1);
        }

        return;
      }

      if (index < end) {
        return;
      }

      if (index === end) {
        interval[1]++;

        const next = values[i + 1];

        if (next && interval[0] + interval[1] === next[0]) {
          interval[1] += next[1];
          values.splice(i + 1, 1);
        }

        return;
      }
    }

    values.push([index, 1]);
  }

  public addAfter(index: number): void {
    if (
      !Number.isSafeInteger(index) ||
      index < -1 ||
      index >= this.itemsCount
    ) {
      throw new RangeError(
        `Index ${index} is out of range for ChangedIntervals ` +
        `insertion (-1..${this.itemsCount - 1})`,
      );
    }

    const insertIndex = index + 1;
    const values = this.values;

    for (let i = 0; i < values.length; i++) {
      const interval = values[i];
      const start = interval[0];
      const end = start + interval[1];

      if (insertIndex > end) {
        continue;
      }

      if (insertIndex >= start) {
        interval[1]++;

        for (let j = i + 1; j < values.length; j++) {
          values[j][0]++;
        }

        this.itemsCount++;
        return;
      }

      for (let j = i; j < values.length; j++) {
        values[j][0]++;
      }

      values.splice(i, 0, [insertIndex, 1]);
      this.itemsCount++;
      return;
    }

    values.push([insertIndex, 1]);
    this.itemsCount++;
  }

  public deleteItems(index: number, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(
        `Invalid ChangedIntervals delete count: ${count}`,
      );
    }

    if (count === 0) {
      return;
    }

    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index + count > this.itemsCount
    ) {
      throw new RangeError(
        `Cannot delete ${count} ChangedIntervals items from ` +
        `index ${index} (length: ${this.itemsCount})`,
      );
    }

    const deleteEnd = index + count;
    const values: ChangedInterval[] = [];

    for (const interval of this.values) {
      const start = interval[0];
      const end = start + interval[1];

      if (end <= index) {
        this.append(values, start, end);
        continue;
      }

      if (start >= deleteEnd) {
        this.append(values, start - count, end - count);
        continue;
      }

      if (start < index) {
        this.append(values, start, index);
      }

      if (end > deleteEnd) {
        this.append(values, index, end - count);
      }
    }

    this.values = values;
    this.itemsCount -= count;
  }

  public clear(): void {
    this.values = [];
  }

  private append(
    values: ChangedInterval[],
    start: number,
    end: number,
  ): void {
    if (start >= end) {
      return;
    }

    const previous = values.at(-1);

    if (
      previous &&
      previous[0] + previous[1] === start
    ) {
      previous[1] += end - start;
      return;
    }

    values.push([start, end - start]);
  }

  private validateIndex(index: number): void {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= this.itemsCount
    ) {
      throw new RangeError(
        `Index ${index} is out of range of ChangedIntervals ` +
        `(0..${this.itemsCount - 1})`,
      );
    }
  }
}
