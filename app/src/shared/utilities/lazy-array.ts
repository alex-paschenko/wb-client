// app/src/shared/utilities/lazy-array.ts

import type {
  CodecFieldName,
  FixedCountArrayCodec,
  FixedSizeCodec,
} from '../types/codecs.js';
import {
  type ChangedInterval,
  type LazyArrayDeletedItems,
} from '../types/lazy-array.js';
import type { EntityDesriptor } from '../types/storage-entities.js';
import type {
  GetChunkAndPosByFlatIndex,
  StorageViewAndPosition,
} from '../types/storage.js';
import { ChangedIntervals } from './changed-intervals.js';
import { entityBinaryCodec } from './codecs/codecs.js';

type ObjectType = Record<string, unknown>;
//
export class LazyArray<T = unknown> {
  private cache: T[];

  private readonly transitoryChanges: ChangedIntervals;
  private readonly cumulativeChanges: ChangedIntervals;

  private readonly codec: FixedSizeCodec;

  private deletedItems: LazyArrayDeletedItems<T>[] = [];

  private cachedViewAndPos: StorageViewAndPosition | null = null;

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

    this.transitoryChanges = new ChangedIntervals(size);
    this.cumulativeChanges = new ChangedIntervals(size);
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
    this.cachedViewAndPos = null;
    const [view, itemIndex] = this.getViewAndPosition(insertIndex);

    const storedValue =
      this.codec.writeByItemIndex(itemIndex, view, value);

    this.cache.splice(insertIndex, 0, storedValue);

    this.transitoryChanges.addAfter(index);
    this.cumulativeChanges.addAfter(index);

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
//
    this.shiftDeletedIndexesAfterDelete(index, count);

    this.cache.splice(index, count);
    this.transitoryChanges.deleteItems(index, count);
    this.cumulativeChanges.deleteItems(index, count);

    this.cachedViewAndPos = null;

    this.storageHasBeenChanged();
  }

  public getTransitoryChanges(): readonly ChangedInterval[] {
    return this.transitoryChanges.intervals;
  }

  public clearTransitoryChanges(): void {
    this.transitoryChanges.clear();
  }

  public getCumulativeChanges(): ChangedIntervals {
    return this.cumulativeChanges;
  }

  public clearCumulativeChanges(): void {
    this.cumulativeChanges.clear();
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
    this.cache = new Array(this.cache.length);
  }

  public clearAll(): void {
    this.clearTransitoryChanges();
    this.clearCumulativeChanges();
    this.clearDeleted();
    this.clearCache();
    this.cachedViewAndPos = null;
  }

  private getItem(index: number): T {
    if (index in this.cache) {
      return this.cache[index];
    }

    const [view, itemIndex] = this.getViewAndPosition(index);

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

    const [view, itemIndex] = this.getViewAndPosition(index);

    return field.readByItemIndex(
      itemIndex,
      view,
    ) as (T & object)[K];
  }

  private setItem(index: number, value: T): T {
    const [view, itemIndex] = this.getViewAndPosition(index);

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

    const [view, itemIndex] = this.getViewAndPosition(index);

    const previousValue = field.readByItemIndex(itemIndex, view);

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
  ): StorageViewAndPosition {
    return this.getChunkAndPosByFlatIndex(
      this.entity.kind,
      this.entity.name,
      index,
    );
  }


  private getViewAndPosition(
    flatIndex: number,
  ): [view: DataView, itemIndex: number] {
    if (
      !this.cachedViewAndPos ||
      flatIndex < this.cachedViewAndPos[2] ||
      flatIndex >= this.cachedViewAndPos[3]
    ) {
      this.cachedViewAndPos = this.getChunkAndPosition(flatIndex);
    }

    return [
      this.cachedViewAndPos[0],
      this.cachedViewAndPos[1] + flatIndex - this.cachedViewAndPos[2],
    ];
  }

  private setChanged(index: number): void {
    this.transitoryChanges.set(index);
    this.cumulativeChanges.set(index);

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
