// app/src/shared/services/storage.ts

import { STORAGE_CHUNK_CAPACITY } from '../constants/storage-config.js';
import { decodeCodec, entityBinaryCodec } from '../utilities/codecs/codecs.js';
import type { StorageEntityKind } from '../constants/storage-entities.js';
import { globalStateService } from './global-state.js';
import type {
  StorageAccessors,
  StorageViewAndPosition,
  StorageChunks,
  StorageChunkSet,
  StorageItemValues,
  ExtendedStoragePersistenceSnapshot,
  SnapshotTypes,
} from '../types/storage.js';
import { LazyArray } from '../utilities/lazy-array.js';
import { storageConfig } from './storage-config.js';
import {
  encodeEntireBinary,
  PredecodedBinary,
} from '../utilities/codecs/entire-binary-codec.js';
import { BinaryKind } from '../constants/binary-kinds.js';
import { STORAGE_DELTA_FLAGS } from '../constants/storage-delta.js';
import type {
  StorageBuiltDeltaChanges,
  StorageDeltaApplyResult,
  StorageDeltaCodecAccumulator,
  StorageDeltaCodecData,
  StorageDeltaEntityChanges,
  StorageDeltaMode,
  StorageDeltaParams,
  StorageStructuralChange,
} from '../types/storage-delta.js';
import { EntityDesriptor } from '../types/storage-entities.js';

const SNAPSHOT_CODEC = 'snapshot v1.0' as const;
const SNAPSHOT_BINARY_KIND = 'snapshot' satisfies BinaryKind;

const DELTA_CODEC = 'delta v1.0' as const;
const DELTA_BINARY_KIND = 'delta' satisfies BinaryKind;

export class Storage {
  private readonly chunkSets: StorageChunkSet[] = [];

  /**
   * Exclusive flat end for each chunkSet.
   *
   * Example:
   *   sizes:            [20, 30, 15]
   *   chunkSetFlatEnds: [20, 50, 65]
   */
  private readonly chunkSetFlatEnds: number[] = [];

  /**
   * Flat index of the first item of each level.
   *
   * The object itself never changes, only its values do.
   */
  private readonly levelsBoundaries: Record<number, number> = {};

  private startLevel0Index: number = 0;

  private accessors: StorageAccessors;

  private persistenceSnapshot: Uint8Array | null = null;

  private clientSnapshot: Uint8Array | null = null;

  private isPersistenceSnapshotBeenTaken: boolean = false;

  private isNeedDelta = false;

  private deltaStartParams: StorageDeltaParams | null = null;

  private readonly structuralChanges: StorageStructuralChange[] = [];

  public constructor(
    private readonly marketName: string,
  ) {
    for (let level = 0; level < storageConfig.numberOfLevels; level++) {
      this.levelsBoundaries[level] = 0;
    }

    this.getChunkAndPosByFlatIndex = this.getChunkAndPosByFlatIndex.bind(this);
    this.invalidateSnapshot = this.invalidateSnapshot.bind(this);

    this.accessors = this.buildAccessors();
  }

  public get size(): number {
    return this.chunkSetFlatEnds.at(-1) ?? 0;
  }

  public get startedAt(): number | null {
    return this.chunkSets[0]?.startedAt ?? null;
  }

  public get endedAt(): number | null {
    return this.chunkSets.at(-1)?.endedAt ?? null;
  }

  public clearTransitoryChanges(): void {
    for (const entity of globalStateService.getStorageEntities()) {
      this.accessors[entity.kind][entity.name].clearTransitoryChanges();
    }
  }

  public clearCumulativeChanges(): void {
    for (const entity of globalStateService.getStorageEntities()) {
      this.accessors[entity.kind][entity.name].clearCumulativeChanges();
    }
  }

  public clearLazyArrayCaches(): void {
    for (const entity of globalStateService.getStorageEntities()) {
      this.accessors[entity.kind][entity.name].clearCache();
    }
  }

  public clearDeleted(): void {
    for (const entity of globalStateService.getStorageEntities()) {
      this.accessors[entity.kind][entity.name].clearDeleted()
    };
  }

  public clearAccessors(): void {
    for (const entity of globalStateService.getStorageEntities()) {
      this.accessors[entity.kind][entity.name].clearAll();
    }
  }

  public initDelta(mode: StorageDeltaMode): void {
    this.structuralChanges.length = 0;
    this.clearCumulativeChanges();

    if (mode === 'restrict') {
      this.isNeedDelta = false;
      this.deltaStartParams = null;
      return;
    }

    this.isNeedDelta = true;
    this.deltaStartParams = this.getDeltaParams();
  }

  public addItem(
    level: number,
    startedAt: number,
    endedAt: number,
    values: StorageItemValues,
  ): number {
    this.invalidateSnapshot();

    const insertFlatIndex = this.addItemStructure(
      level,
      startedAt,
      endedAt,
    );

    const afterFlatIndex = insertFlatIndex - 1;

    for (const entity of globalStateService.getStorageEntities()) {
      const kindValues = values[entity.kind];

      const hasValue = kindValues !== undefined &&
        Object.prototype.hasOwnProperty.call(kindValues, entity.name);

      const value = hasValue ? kindValues[entity.name] : entity.empty;

      this.accessors[entity.kind][entity.name].addAfter(
        afterFlatIndex,
        value,
      );
    }

    if (this.isNeedDelta) {
      this.structuralChanges.push({
        type: 'addItem',
        level,
        startedAt,
        endedAt,
      });
    }

    return insertFlatIndex;
  }

  public deleteNItems(
    level: number,
    count: number,
    newStartedAt?: number,
  ): StorageChunkSet[] {
    this.validateDeleteItems(level, count);

    if (count === 0) {
      return [];
    }

    const flatIndex = this.levelsBoundaries[level];
    const collectDeleted = level !== storageConfig.maxLevel;

    this.invalidateSnapshot();

    /*
    * This must happen before changing chunkSets because LazyArray may need
    * to materialize the values being removed.
    */
    for (const entity of globalStateService.getStorageEntities()) {
      this.accessors[entity.kind][entity.name].deleteItems(
        flatIndex,
        count,
        collectDeleted,
      );
    }

    const normalizedStartedAt = newStartedAt ?? null;

    const removedChunkSets = this.deleteNItemsStructure(
      level,
      count,
      normalizedStartedAt,
    );

    if (this.isNeedDelta) {
      this.structuralChanges.push({
        type: 'deleteItems',
        level,
        count,
        newStartedAt: normalizedStartedAt,
      });
    }

    return removedChunkSets;
  }

  public getBinaryDelta(): Uint8Array | null {
    if (!this.isNeedDelta) {
      return null;
    }

    if (!this.deltaStartParams) {
      throw new Error(
        'Storage delta start params are not initialized',
      );
    }

    if (this.chunkSets.length > 0xff) {
      throw new RangeError(
        `Storage has ${this.chunkSets.length} chunk sets, ` +
        `uint8 delta format supports at most 255`,
      );
    }

    const endParams = this.getDeltaParams();

    const structuralAppendOnly =
      this.isStructuralDeltaAppendOnly(this.deltaStartParams, endParams);

    const entities = globalStateService.getClientStorageEntities();

    const { entityChanges, appendOnly } = this.buildDeltaChangeIntervals(
      structuralAppendOnly,
      entities,
    );

    const flags = appendOnly ? STORAGE_DELTA_FLAGS.appendOnly : 0;

    const data = encodeEntireBinary(
      {
        codecName: DELTA_CODEC,
        binaryKind: DELTA_BINARY_KIND,
        parameters: { marketName: this.marketName },
        data: {
          flags,
          startParams: this.deltaStartParams,
          endParams,
          structuralChanges: this.structuralChanges,
          entityChanges,
        },
      },
      this.getDeltaCodecAccumulator(entities),
    );

    this.isNeedDelta = false;
    this.deltaStartParams = null;
    this.structuralChanges.length = 0;
    this.clearCumulativeChanges();

    return data;
  }

  public applyDelta(delta: PredecodedBinary): StorageDeltaApplyResult {
    const decoded = decodeCodec(
      delta.codecName,
      delta.data,
      this.getDeltaCodecAccumulator(),
    ) as StorageDeltaCodecData;

    this.rebuildIndexMetadata();
    this.updateStartLevel0Index();

    /*
    * Old LazyArrays contain geometry and cache corresponding to the
    * pre-delta storage. Recreate them only after the decoder has finished.
    */
    this.accessors = this.buildAccessors();

    this.invalidateSnapshot();

    return {
      appendOnly:
        (decoded.flags & STORAGE_DELTA_FLAGS.appendOnly) !== 0,
    };
  }

  public getAccessors(): StorageAccessors {
    return this.accessors;
  }

  public getBinarySnapshot(): Uint8Array {
    if (!this.clientSnapshot) {
      this.clientSnapshot = this.encodeSnapshot(
        this.chunkSets,
        globalStateService.getClientStorageEntities(),
      );
    }

    return this.clientSnapshot;
  }

  public applySnapshot(snapshot: PredecodedBinary): void {
    if (this.chunkSets.length > 0) {
      throw new Error(
        `We can't run applySnapshot twice (market: "${this.marketName}")`,
      );
    }

    const { chunkSets } = decodeCodec(
      snapshot.codecName,
      snapshot.data,
    ) as { chunkSets: StorageChunkSet[]; };

    for (const chunkSet of chunkSets) {
      this.validateChunkSet(chunkSet);
      this.initializeChunkViews(chunkSet);
    }

    this.validateChunkSetOrder(chunkSets);

    this.chunkSets.push(...chunkSets);

    this.rebuildIndexMetadata();
    this.updateStartLevel0Index();

    this.accessors = this.buildAccessors();

    this.invalidateSnapshot();
  }

  public getPersistenceSnapshot(
    snapshots: SnapshotTypes,
    archiveStartIndex: number,
    archiveStartedAt: number,
  ): ExtendedStoragePersistenceSnapshot[] {
    if (this.isPersistenceSnapshotBeenTaken || this.chunkSets.length === 0) {
      return [];
    }

    if (
      !Number.isSafeInteger(archiveStartIndex) ||
      archiveStartIndex < 0 ||
      archiveStartIndex >= this.size
    ) {
      throw new RangeError(
        `Invalid archive start index: ${archiveStartIndex}`,
      );
    }

    const firstChunkSet = this.chunkSets[0];
    const lastChunkSet = this.chunkSets.at(-1)!;

    const result: ExtendedStoragePersistenceSnapshot[] =
      snapshots === 'both snapshots'
      ? [{
          snapshotType: 'active',
          marketName: this.marketName,
          startedAt: firstChunkSet.startedAt,
          endedAt: lastChunkSet.endedAt,
          data: this.getPersistenceSnapshotBinary(),
        }]
      : [];

    const firstArchiveChunkSetIndex =
      this.findChunkSetIndex(archiveStartIndex);

    const archiveChunkSets = this.chunkSets.slice(
      firstArchiveChunkSetIndex,
    );

    archiveChunkSets[0] = this.cutChunkSetBy(
      archiveChunkSets[0],
      archiveStartIndex,
      archiveStartedAt,
    );

    result.push({
      snapshotType: 'archive',
      marketName: this.marketName,
      startedAt: archiveStartedAt,
      endedAt: lastChunkSet.endedAt,
      data: this.encodeSnapshot(
        archiveChunkSets,
        globalStateService.getStorageEntities(),
      ),
    });

    this.isPersistenceSnapshotBeenTaken = true;

    return result;
  }

  public get levelBoundaries(): Record<number, number> {
    return this.levelsBoundaries;
  }

  public getChunkAndPosByFlatIndex(
    kind: StorageEntityKind,
    name: string,
    flatIndex: number,
  ): StorageViewAndPosition {
    if (!Number.isSafeInteger(flatIndex) || flatIndex < 0 || flatIndex >= this.size) {
      throw new RangeError(
        `Invalid storage flat index: ${flatIndex} (length: ${this.size})`,
      );
    }

    const chunkSetIndex = this.findChunkSetIndex(flatIndex);
    const chunkSet = this.chunkSets[chunkSetIndex];

    const previousFlatEnd =
      chunkSetIndex === 0 ? 0 : this.chunkSetFlatEnds[chunkSetIndex - 1];
    const currentFlatEnd = this.chunkSetFlatEnds[chunkSetIndex];

    const itemOffset = flatIndex - previousFlatEnd;
    const itemIndex = chunkSet.start + itemOffset;

    if (itemIndex < chunkSet.start || itemIndex >= chunkSet.end) {
      throw new Error(
        `Resolved item index ${itemIndex} is outside chunk set ` +
        `${this.chunkSetDescription(chunkSet)} ` +
        `(${chunkSet.start}..${chunkSet.end})`,
      );
    }

    const chunk = chunkSet.chunks[kind]?.[name];

    if (!chunk) {
      throw new Error(
        `Storage chunk ${kind} "${name}" not found in chunk set ` +
        `${this.chunkSetDescription(chunkSet)}`,
      );
    }

    return [
      chunk.view,
      chunkSet.start,
      currentFlatEnd - chunkSet.size,
      currentFlatEnd,
    ];
  }

  private addItemStructure(
    level: number,
    startedAt: number,
    endedAt: number,
  ): number {
    this.validateLevel(level);
    this.validateTimeBoundaries(startedAt, endedAt);

    const insertFlatIndex = this.getLevelEndFlatIndex(level);
    const insertionIndex = this.getChunkSetInsertionIndex(level);

    let chunkSet = this.chunkSets[insertionIndex - 1];

    if (
      !chunkSet ||
      chunkSet.level !== level ||
      chunkSet.end >= STORAGE_CHUNK_CAPACITY
    ) {
      chunkSet = this.createChunkSet(
        level,
        startedAt,
        endedAt,
      );

      this.chunkSets.splice(insertionIndex, 0, chunkSet);
      this.insertChunkSetFlatEnd(insertionIndex, 1);
    } else {
      chunkSet.end += 1;
      chunkSet.size += 1;
      chunkSet.endedAt = endedAt;

      this.incrementFlatEndsFrom(insertionIndex - 1, 1);
    }

    this.incrementLowerLevelBoundaries(level, 1);
    this.updateStartLevel0Index();

    return insertFlatIndex;
  }

  private deleteNItemsStructure(
    level: number,
    count: number,
    newStartedAt: number | null,
  ): StorageChunkSet[] {
    this.validateDeleteItems(level, count);

    if (count === 0) {
      return [];
    }

    const removedChunkSets: StorageChunkSet[] = [];

    let remaining = count;
    let chunkSetIndex = this.getFirstChunkSetIndex(level);

    while (remaining > 0) {
      const chunkSet = this.chunkSets[chunkSetIndex];

      if (!chunkSet || chunkSet.level !== level) {
        throw new Error(
          `Storage level ${level} ended while deleting ` +
          `${count} items`,
        );
      }

      if (remaining >= chunkSet.size) {
        remaining -= chunkSet.size;

        removedChunkSets.push(chunkSet);
        this.chunkSets.splice(chunkSetIndex, 1);

        continue;
      }

      chunkSet.start += remaining;
      chunkSet.size -= remaining;
      remaining = 0;

      if (newStartedAt === null) {
        throw new Error(
          `newStartedAt is required when partially deleting ` +
          `storage level ${level}`,
        );
      }

      if (!Number.isFinite(newStartedAt)) {
        throw new TypeError(
          `Invalid newStartedAt: ${newStartedAt}`,
        );
      }

      chunkSet.startedAt = newStartedAt;
    }

    this.rebuildIndexMetadata();
    this.updateStartLevel0Index();

    return removedChunkSets;
  }

  private validateDeleteItems(
    level: number,
    count: number,
  ): void {
    this.validateLevel(level);

    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`Invalid delete count: ${count}`);
    }

    const levelSize = this.getLevelSize(level);

    if (count > levelSize) {
      throw new RangeError(
        `Cannot delete ${count} items from storage level ` +
        `${level} (size: ${levelSize})`,
      );
    }
  }

  private applyStructuralChanges(
    changes: readonly StorageStructuralChange[],
  ): void {
    for (const change of changes) {
      if (change.type === 'addItem') {
        this.addItemStructure(change.level, change.startedAt, change.endedAt);
        continue;
      }

      this.deleteNItemsStructure(change.level, change.count, change.newStartedAt);
    }
  }

  private getDeltaParams(): StorageDeltaParams {
    return {
      size: this.size,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    };
  }

  private getDeltaCodecAccumulator(
    entities: readonly EntityDesriptor[] =
      globalStateService.getStorageEntities(),
  ): StorageDeltaCodecAccumulator {
    return {
      entities,
      getCurrentParams: () => this.getDeltaParams(),
      getChunkSets: () => this.chunkSets,
      applyStructuralChanges: (changes) => {
        this.applyStructuralChanges(changes);
      },
    };
  }

  private isStructuralDeltaAppendOnly(
    startParams: StorageDeltaParams,
    endParams: StorageDeltaParams,
  ): boolean {
    if (endParams.size !== startParams.size + 1) {
      return false;
    }

    if (this.structuralChanges.length !== 1) {
      return false;
    }

    const change = this.structuralChanges[0];

    return change.type === 'addItem' && change.level === 0;
  }

  private buildDeltaChangeIntervals(
    structuralAppendOnly: boolean,
    entities: readonly EntityDesriptor[],
  ): StorageBuiltDeltaChanges {
    const entityChanges: StorageDeltaEntityChanges[] = [];
    let appendOnly = structuralAppendOnly;
    const appendedFlatIndex = this.size - 1;

    for (const [entityIndex, entity] of entities.entries()) {
      const changedIntervals = this.accessors[entity.kind][entity.name]
        .getCumulativeChanges();

      if (changedIntervals.length !== this.size) {
        throw new Error(
          `Changed intervals length mismatch for ` +
          `${entity.kind}:${entity.name}: ` +
          `${changedIntervals.length} !== ${this.size}`,
        );
      }

      if (changedIntervals.intervals.length === 0) {
        continue;
      }

      const changes = [];
      let chunkSetIndex = 0;
      let previousFlatEnd = 0;

      for (const [startFlatIndex, count] of changedIntervals.intervals) {
        let flatIndex = startFlatIndex;
        let remainingCount = count;

        if (flatIndex !== appendedFlatIndex || remainingCount !== 1) {
          appendOnly = false;
        }

        while (remainingCount > 0) {
          while (flatIndex >= this.chunkSetFlatEnds[chunkSetIndex]) {
            previousFlatEnd = this.chunkSetFlatEnds[chunkSetIndex];

            chunkSetIndex++;
          }

          const chunkSetFlatEnd = this.chunkSetFlatEnds[chunkSetIndex];

          const itemsCount = Math.min(
            remainingCount,
            chunkSetFlatEnd - flatIndex,
          );

          changes.push({
            chunkSetIndex,
            startItemIndex: flatIndex - previousFlatEnd,
            itemsCount,
          });

          flatIndex += itemsCount;
          remainingCount -= itemsCount;
        }
      }

      entityChanges.push({
        entityKind: entity.kind,
        entityName: entity.name,
        entityIndex,
        changes,
      });
    }

    return { entityChanges, appendOnly };
  }

  private buildAccessors() {
    return globalStateService.mapStorageEntities(
      (entity) =>
        new LazyArray(
          entity,
          this.size,
          this.getChunkAndPosByFlatIndex,
          this.invalidateSnapshot,
        ),
      2,
    );
  }

  private createChunkSet(
    level: number,
    startedAt: number,
    endedAt: number,
  ): StorageChunkSet {
    return {
      level,
      start: 0,
      end: 1,
      size: 1,
      startedAt,
      endedAt,
      chunks: this.createChunks(),
    };
  }

  private createChunks(): StorageChunks {
    return globalStateService.mapStorageEntities(
      (entity) => {
        const codec = entityBinaryCodec(entity.codec);
        const data = new Uint8Array(codec.size * STORAGE_CHUNK_CAPACITY);

        return {
          data,
          view: new DataView(data.buffer, data.byteOffset, data.byteLength),
        };
      }
    );
  }

  private findChunkSetIndex(flatIndex: number): number {
    let left = 0;
    let right = this.chunkSetFlatEnds.length - 1;

    while (left < right) {
      const middle = (left + right) >>> 1;

      if (flatIndex < this.chunkSetFlatEnds[middle]) {
        right = middle;
      } else {
        left = middle + 1;
      }
    }

    return left;
  }

  private getChunkSetInsertionIndex(level: number): number {
    for (let index = 0; index < this.chunkSets.length; index++) {
      if (this.chunkSets[index].level < level) {
        return index;
      }
    }

    return this.chunkSets.length;
  }

  private getFirstChunkSetIndex(level: number): number {
    for (let index = 0; index < this.chunkSets.length; index++) {
      if (this.chunkSets[index].level === level) {
        return index;
      }
    }

    throw new Error(`Storage level ${level} has no chunk sets`);
  }

  private getLevelEndFlatIndex(level: number): number {
    return level === 0
      ? this.size
      : this.levelsBoundaries[level - 1];
  }

  private getLevelSize(level: number): number {
    return this.getLevelEndFlatIndex(level) -
      this.levelsBoundaries[level];
  }

  private insertChunkSetFlatEnd(
    chunkSetIndex: number,
    size: number,
  ): void {
    const previousEnd =
      chunkSetIndex === 0
        ? 0
        : this.chunkSetFlatEnds[chunkSetIndex - 1];

    this.chunkSetFlatEnds.splice(
      chunkSetIndex,
      0,
      previousEnd + size,
    );

    this.incrementFlatEndsFrom(chunkSetIndex + 1, size);
  }

  private cutChunkSetBy(
    chunkSet: StorageChunkSet,
    startFlatIndex: number,
    startedAt: number,
  ): StorageChunkSet {
    const chunkSetIndex = this.findChunkSetIndex(startFlatIndex);
    const previousFlatEnd = chunkSetIndex === 0
      ? 0
      : this.chunkSetFlatEnds[chunkSetIndex - 1];

    const start = chunkSet.start + startFlatIndex - previousFlatEnd;

    if (start < chunkSet.start || start >= chunkSet.end) {
      throw new RangeError(
        `Invalid cut position ${startFlatIndex} for ` +
        this.chunkSetDescription(chunkSet),
      );
    }

    return {
      ...chunkSet,
      start,
      size: chunkSet.end - start,
      startedAt,
    };
  }

  private incrementFlatEndsFrom(index: number, delta: number): void {
    for (
      let currentIndex = index;
      currentIndex < this.chunkSetFlatEnds.length;
      currentIndex++
    ) {
      this.chunkSetFlatEnds[currentIndex] += delta;
    }
  }

  private incrementLowerLevelBoundaries(
    level: number,
    delta: number,
  ): void {
    for (let currentLevel = 0; currentLevel < level; currentLevel++) {
      this.levelsBoundaries[currentLevel] += delta;
    }
  }

  private rebuildIndexMetadata(): void {
    this.chunkSetFlatEnds.length = 0;

    let flatEnd = 0;

    for (const chunkSet of this.chunkSets) {
      flatEnd += chunkSet.size;
      this.chunkSetFlatEnds.push(flatEnd);
    }

    let chunkSetIndex = 0;
    let flatIndex = 0;

    for (let level = storageConfig.maxLevel; level >= 0; level--) {
      this.levelsBoundaries[level] = flatIndex;

      while (
        chunkSetIndex < this.chunkSets.length &&
        this.chunkSets[chunkSetIndex].level === level
      ) {
        flatIndex += this.chunkSets[chunkSetIndex].size;
        chunkSetIndex++;
      }
    }

    if (chunkSetIndex !== this.chunkSets.length) {
      throw new Error(
        'Storage chunk sets are not grouped by descending level',
      );
    }
  }

  private updateStartLevel0Index(): void {
    this.startLevel0Index = this.chunkSets.length;

    for (let index = this.chunkSets.length - 1; index >= 0; index--) {
      if (this.chunkSets[index].level !== 0) {
        break;
      }

      this.startLevel0Index = index;
    }
  }

  private initializeChunkViews(chunkSet: StorageChunkSet): void {
    for (const entity of globalStateService.getStorageEntities()) {
      const chunk = chunkSet.chunks[entity.kind]?.[entity.name];

      if (!chunk) {
        throw new Error(
          `Chunk set ${this.chunkSetDescription(chunkSet)} has no ` +
          `${entity.kind} "${entity.name}" chunk`,
        );
      }

      const codec = entityBinaryCodec(entity.codec);
      const expectedLength = codec.size * STORAGE_CHUNK_CAPACITY;

      if (chunk.data.byteLength !== expectedLength) {
        throw new Error(
          `Invalid ${entity.kind} "${entity.name}" chunk size in chunk set ` +
          `${this.chunkSetDescription(chunkSet)}: ${chunk.data.byteLength}, ` +
          `expected ${expectedLength}`,
        );
      }

      chunk.view = new DataView(
        chunk.data.buffer,
        chunk.data.byteOffset,
        chunk.data.byteLength,
      );
    }
  }

  private validateChunkSet(chunkSet: StorageChunkSet): void {
    this.validateLevel(chunkSet.level);

    if (
      !Number.isSafeInteger(chunkSet.start) ||
      !Number.isSafeInteger(chunkSet.end) ||
      !Number.isSafeInteger(chunkSet.size) ||
      chunkSet.start < 0 ||
      chunkSet.end > STORAGE_CHUNK_CAPACITY ||
      chunkSet.start >= chunkSet.end ||
      chunkSet.size !== chunkSet.end - chunkSet.start
    ) {
      throw new Error(
        `Invalid geometry of chunk set ${this.chunkSetDescription(chunkSet)}: ` +
        `start=${chunkSet.start}, end=${chunkSet.end}, ` +
        `size=${chunkSet.size}`,
      );
    }

    this.validateTimeBoundaries(
      chunkSet.startedAt,
      chunkSet.endedAt,
    );
  }

  private validateChunkSetOrder(
    chunkSets: readonly StorageChunkSet[],
  ): void {
    let previousLevel: number = storageConfig.numberOfLevels;

    for (let index = 0; index < chunkSets.length; index++) {
      const chunkSet = chunkSets[index];

      if (chunkSet.level > previousLevel) {
        throw new Error(
          `Storage chunk set ${this.chunkSetDescription(chunkSet)} breaks ` +
          `descending level order`,
        );
      }

      if (index > 0) {
        const previous = chunkSets[index - 1];

        if (chunkSet.startedAt <= previous.startedAt) {
          throw new Error(
            `Storage chunk sets ${this.chunkSetDescription(previous)} and ` +
            `${this.chunkSetDescription(chunkSet)} have invalid startedAt order`,
          );
        }

        if (chunkSet.startedAt <= previous.endedAt) {
          throw new Error(
            `Storage chunk sets ${this.chunkSetDescription(previous)} and ` +
            `${this.chunkSetDescription(chunkSet)} overlap`,
          );
        }
      }

      previousLevel = chunkSet.level;
    }
  }

  private validateLevel(level: number): void {
    if (
      !Number.isSafeInteger(level) ||
      level < 0 ||
      level >= storageConfig.numberOfLevels
    ) {
      throw new RangeError(`Invalid storage level: ${level}`);
    }
  }

  private validateTimeBoundaries(
    startedAt: number,
    endedAt: number,
  ): void {
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || startedAt > endedAt) {
      throw new TypeError(
        `Invalid storage time boundaries: ${startedAt}..${endedAt}`,
      );
    }
  }

  private encodeSnapshot(
    chunkSets: StorageChunkSet[],
    entities: readonly EntityDesriptor[],
  ): Uint8Array {
    return encodeEntireBinary(
      {
        codecName: SNAPSHOT_CODEC,
        binaryKind: SNAPSHOT_BINARY_KIND,
        parameters: { marketName: this.marketName },
        data: { chunkSets },
      },
      { entities },
    );
  }

  private getPersistenceSnapshotBinary():
    Uint8Array {
    if (!this.persistenceSnapshot) {
      this.persistenceSnapshot = this.encodeSnapshot(
        this.chunkSets,
        globalStateService.getStorageEntities(),
      );
    }

    return this.persistenceSnapshot;
  }

  private invalidateSnapshot = (): void => {
    this.persistenceSnapshot = null;
    this.clientSnapshot = null;

    this.isPersistenceSnapshotBeenTaken = false;
  };

  private chunkSetDescription(chunkSet: StorageChunkSet): string {
    return `"level: ${chunkSet.level}, startedAt: ${chunkSet.startedAt},` +
      ` endedAt: ${chunkSet.endedAt}"`
  }

}
