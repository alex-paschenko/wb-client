// app/src/shared/utilities/lazy-array.ts

// app/src/shared/utilities/lazy-array.ts

import type {
  CodecFieldName,
  FixedCountArrayCodec,
  FixedSizeCodec,
} from '../types/codecs.js';
import {
  changedIntervalIndexes,
  type ChangedInterval,
  type LazyArrayDeletedItems,
} from '../types/lazy-array.js';
import type { EntityDesriptor } from '../types/storage-entities.js';
import type {
  GetChunkAndPosByFlatIndex,
  StorageChunkAndPosition,
} from '../types/storage.js';
import { Bitmap } from './bitmap.js';
import { entityBinaryCodec } from './codecs/codecs.js';

type ObjectType = Record<string, unknown>;

export class LazyArray<T = unknown> {
  private readonly cache: T[];

  private readonly transitoryChangedItems: Bitmap;
  private readonly cumulativeChangedItems: Bitmap;

  private readonly codec: FixedSizeCodec;

  private deletedItems: LazyArrayDeletedItems<T>[] = [];

  public constructor(
    private readonly entity: EntityDesriptor,
    size: number,
    private readonly getChunkAndPosByFlatIndex: GetChunkAndPosByFlatIndex,
    private readonly storageHasBeenChanged: () => void,
  ) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TypeError(`Invalid LazyArray size: ${size}`);
    }

    this.codec = entityBinaryCodec(entity.codec);
    this.cache = new Array<T>(size);

    this.transitoryChangedItems = new Bitmap(size);
    this.cumulativeChangedItems = new Bitmap(size);
  }

  public get length(): number {
    return this.cache.length;
  }

  public get(index: number): T;

  public get<K extends CodecFieldName<T & object>>(
    index: number,
    fieldName: K,
  ): (T & object)[K];

  public get(
    index: number,
    fieldName?: CodecFieldName<T & object>,
  ): unknown {
    this.validateIndex(index);

    if (arguments.length === 1) {
      return this.getItem(index);
    }

    return this.getField(index, fieldName!);
  }

  public set(index: number, value: T): T;

  public set<K extends CodecFieldName<T & object>>(
    index: number,
    fieldName: K,
    value: (T & object)[K],
  ): (T & object)[K];

  public set(
    index: number,
    fieldOrValue: CodecFieldName<T & object> | T,
    fieldValue?: unknown,
  ): unknown {
    this.validateIndex(index);

    if (arguments.length === 2) {
      return this.setItem(index, fieldOrValue as T);
    }

    return this.setField(
      index,
      fieldOrValue as CodecFieldName<T & object>,
      fieldValue,
    );
  }

  public addAfter(index: number, value: T): T {
    if (
      !Number.isSafeInteger(index) ||
      index < -1 ||
      index >= this.length
    ) {
      throw new RangeError(
        `Invalid LazyArray insertion index: ${index} ` +
        `(length: ${this.length})`,
      );
    }

    const insertIndex = index + 1;

    /*
     * Storage has already inserted the physical item, so the new flat
     * index can already be resolved by the callback.
     */
    const { view, itemIndex } =
      this.getChunkAndPosition(insertIndex);

    const storedValue =
      this.codec.writeByItemIndex(itemIndex, view, value);

    this.cache.splice(insertIndex, 0, storedValue);

    this.transitoryChangedItems.addAfter(index);
    this.cumulativeChangedItems.addAfter(index);

    this.shiftDeletedIndexesAfterInsert(insertIndex);

    this.storageHasBeenChanged();

    return storedValue;
  }

  public deleteItems(
    index: number,
    count: number,
    collectDeleted: boolean,
  ): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`Invalid LazyArray delete count: ${count}`);
    }

    if (count === 0) {
      return;
    }

    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index + count > this.length
    ) {
      throw new RangeError(
        `Cannot delete ${count} LazyArray items from index ${index} ` +
        `(length: ${this.length})`,
      );
    }

    /*
     * This must happen while physical storage still contains these items.
     */
    if (collectDeleted && this.entity.requiresRemovedValues) {
      const values = new Array<T>(count);

      for (let offset = 0; offset < count; offset++) {
        values[offset] = this.getItem(index + offset);
      }

      this.deletedItems.push({ index, values });
    }

    this.shiftDeletedIndexesAfterDelete(index, count);

    this.cache.splice(index, count);
    this.transitoryChangedItems.deleteItems(index, count);
    this.cumulativeChangedItems.deleteItems(index, count);

    this.storageHasBeenChanged();
  }

  public getTransitoryChanges(): ChangedInterval[] {
    return this.getChanges(this.transitoryChangedItems);
  }

  public clearTransitoryChanges(): void {
    this.transitoryChangedItems.clearAll();
  }

  public getCumulativeChanges(): Bitmap {
    return this.cumulativeChangedItems;;
  }

  public clearCumulativeChanges(): void {
    this.cumulativeChangedItems.clearAll();
  }

  public getDeleted(): LazyArrayDeletedItems<T>[] {
    return this.deletedItems;
  }

  public clearDeleted(): void {
    this.deletedItems = [];
  }

  public getCache(): readonly T[] {
    return this.cache;
  }

  public clearCache(): void {
    for (let index = 0; index < this.cache.length; index++) {
      delete this.cache[index];
    }
  }

  public clearAll(): void {
    this.clearTransitoryChanges();
    this.clearCumulativeChanges();
    this.clearDeleted();
    this.clearCache();
  }

  private getChanges(bitmap: Bitmap): ChangedInterval[] {
    const intervals: ChangedInterval[] = [];

    for (let index = 0; index < this.cache.length; index++) {
      if (!bitmap.get(index)) {
        continue;
      }

      const lastInterval = intervals.at(-1);

      if (
        lastInterval &&
        lastInterval[changedIntervalIndexes.startFlatAscIndex] +
          lastInterval[changedIntervalIndexes.count] === index
      ) {
        lastInterval[changedIntervalIndexes.count] += 1;
      } else {
        intervals.push([index, 1]);
      }
    }

    return intervals;
  }

  private getItem(index: number): T {
    if (index in this.cache) {
      return this.cache[index];
    }

    const { view, itemIndex } = this.getChunkAndPosition(index);

    const value = this.codec.readByItemIndex(itemIndex, view) as T;

    this.cache[index] = value;

    return value;
  }

  private getField<K extends CodecFieldName<T & object>>(
    index: number,
    fieldName: K,
  ): (T & object)[K] {
    const codec = this.getObjectCodec();

    if (index in this.cache) {
      return (this.cache[index] as T & object)[fieldName];
    }

    const field = codec.fields[fieldName];

    if (!field) {
      throw new Error(
        `Field "${fieldName}" not found in codec ` +
        `"${this.entity.codec}"`,
      );
    }

    const { view, itemIndex } =
      this.getChunkAndPosition(index);

    return field.readByItemIndex(
      itemIndex,
      view,
    ) as (T & object)[K];
  }

  private setItem(index: number, value: T): T {
    const { view, itemIndex } =
      this.getChunkAndPosition(index);

    const previousValue =
      this.codec.readByItemIndex(itemIndex, view) as T;

    const storedValue =
      this.codec.writeByItemIndex(itemIndex, view, value) as T;

    this.cache[index] = storedValue;

    if (!this.valuesEqual(previousValue, storedValue)) {
      this.setChanged(index);
    }

    return storedValue;
  }

  private setField<K extends CodecFieldName<T & object>>(
    index: number,
    fieldName: K,
    value: unknown,
  ): (T & object)[K] {
    const codec = this.getObjectCodec();
    const field = codec.fields[fieldName];

    if (!field) {
      throw new Error(
        `Field "${fieldName}" not found in codec ` +
        `"${this.entity.codec}"`,
      );
    }

    const { view, itemIndex } =
      this.getChunkAndPosition(index);

    const previousValue =
      field.readByItemIndex(itemIndex, view);

    const storedValue = field.writeByItemIndex(
      itemIndex,
      view,
      value,
    ) as (T & object)[K];

    if (index in this.cache) {
      this.cache[index] = {
        ...(this.cache[index] as T & object),
        [fieldName]: storedValue,
      } as T;
    }

    if (!Object.is(previousValue, storedValue)) {
      this.setChanged(index);
    }

    return storedValue;
  }

  private valuesEqual(first: T, second: T): boolean {
    if (this.codec.dataKind === 'primitive') {
      return Object.is(first, second);
    }

    const firstObject = first as T & ObjectType;
    const secondObject = second as T & ObjectType;

    for (const fieldName of this.codec.fieldNames) {
      if (!Object.is(
        firstObject[fieldName],
        secondObject[fieldName],
      )) {
        return false;
      }
    }

    return true;
  }

  private shiftDeletedIndexesAfterInsert(insertIndex: number): void {
    for (const deleted of this.deletedItems) {
      if (deleted.index > insertIndex) {
        deleted.index++;
      }
    }
  }

  private shiftDeletedIndexesAfterDelete(
    index: number,
    count: number,
  ): void {
    for (const deleted of this.deletedItems) {
      if (deleted.index > index) {
        deleted.index = Math.max(
          index,
          deleted.index - count,
        );
      }
    }
  }

  private getObjectCodec(): FixedCountArrayCodec<T & object> {
    if (this.codec.dataKind !== 'fixedCountArray') {
      throw new TypeError(
        `Storage entity ${this.entity.kind} "${this.entity.name}" ` +
        `uses primitive codec "${this.entity.codec}"`,
      );
    }

    return this.codec;
  }

  private getChunkAndPosition(
    index: number,
  ): StorageChunkAndPosition {
    return this.getChunkAndPosByFlatIndex(
      this.entity.kind,
      this.entity.name,
      index,
    );
  }

  private setChanged(index: number): void {
    this.transitoryChangedItems.set(index, true);
    this.cumulativeChangedItems.set(index, true);

    this.storageHasBeenChanged();
  }

  private validateIndex(index: number): void {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= this.length
    ) {
      throw new RangeError(
        `Invalid LazyArray index: ${index} ` +
        `(length: ${this.length})`,
      );
    }
  }
}
