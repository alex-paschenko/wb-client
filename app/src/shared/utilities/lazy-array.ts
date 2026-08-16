// app/src/shared/utilities/lazy-array.ts

import {
  changedIntervalIndexes,
  type LazyArraySetResult,
  type ChangedInterval,
  type LazyArrayResults,
} from '../types/lazy-array';
import type {
  MarketDataArray,
  MarketDataProjectionDirection
} from '../types/market-statistics-storage';
import { Bitmap } from './bitmap';

const missingInterval: ChangedInterval = [-1, -1];

function isArrayIndexProperty(property: string): boolean {
  if (property === '') {
    return false;
  }

  const index = Number(property);

  return (
    Number.isInteger(index) &&
    index >= 0 &&
    String(index) === property
  );
}

export class LazyArray<T> {
  private readonly cache: T[];

  private readonly changedItems: Bitmap;

  private readonly getItem: (index: number) => T;

  private readonly setItem:
    ((index: number, value: T) => LazyArraySetResult<T>) | null;

  private readonly name: string;

  private readonly size: number;

  private cachedResults: LazyArrayResults<T> | null = null;

  constructor(params: {
    readonly getItem: (index: number) => T,
    readonly setItem:
      ((index: number, value: T) => LazyArraySetResult<T>) | null,
    readonly name: string,
    readonly size: number,
  }) {
    const size = params.size;

    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TypeError(`Invalid LazyArray size: ${size}`);
    }

    this.getItem = params.getItem;
    this.setItem = params.setItem;
    this.name = params.name;
    this.size = size;

    this.cache = new Array<T>(size);
    this.changedItems = new Bitmap(size);
  }

  getProxy(
    direction: MarketDataProjectionDirection,
  ): MarketDataArray<T> {
    const lazyArray = this;

    const target = {
      get length(): number {
        return lazyArray.size;
      },
    };

    const normalizeIndex = (index: number): number => {
      if (
        !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= lazyArray.size
      ) {
        throw new RangeError(
          `Invalid index in LazyArray: ${index} ` +
          `(size: ${lazyArray.size})`,
        );
      }

      return direction === 'ascending'
        ? index
        : lazyArray.size - 1 - index;
    };

    return new Proxy(target, {
      get(proxyTarget, property, receiver) {
        if (
          typeof property === 'string' &&
            isArrayIndexProperty(property)
        ) {
          const index = normalizeIndex(Number(property));
          const cache = lazyArray.cache;

          if (index in cache) {
            return cache[index];
          }

          const value = lazyArray.getItem(index);
          cache[index] = value;

          return value;
        }

        return Reflect.get(proxyTarget, property, receiver);
      },

      set(_proxyTarget, property, value) {
        if (
          typeof property !== 'string' ||
          !isArrayIndexProperty(property)
        ) {
          throw new TypeError(
            `Can't set LazyArray property "${String(property)}"`,
          );
        }

        if (!lazyArray.setItem) {
          throw new Error(`${lazyArray.name} is read-only`);
        }

        const index = normalizeIndex(Number(property));

        const result = lazyArray.setItem(index, value as T);

        lazyArray.cache[index] = result.value;

        if (result.changed) {
          lazyArray.changedItems.set(index, true);
          lazyArray.cachedResults = null;
        }

        return true;
      },

      deleteProperty() {
        throw new TypeError('Can\'t delete data from LazyArray');
      },

      defineProperty() {
        throw new TypeError('Can\'t define properties on LazyArray');
      },
    }) as MarketDataArray<T>;
  }

  getCache(): readonly T[] {
    return this.cache;
  }

  getCachedResults(): LazyArrayResults<T> {
    if (this.cachedResults) {
      return this.cachedResults;
    }

    const intervals: ChangedInterval[] = [];

    for (let index = 0; index < this.cache.length; index++) {
      if (this.changedItems.get(index)) {
        const lastInterval =
          intervals[intervals.length - 1] ?? missingInterval;
        const [startFlatAscIndex, count] = lastInterval;

        if (startFlatAscIndex + count === index) {
          lastInterval[changedIntervalIndexes.count] += 1;
        } else {
          intervals.push([index, 1]);
        }
      }
    }

    this.cachedResults = {
      name: this.name,
      changedIntervals: intervals,
      cache: this.cache,
    };

    return this.cachedResults;
  }
}
