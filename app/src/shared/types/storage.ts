// app/src/shared/types/storage.ts

import type { StorageEntityKind } from '../constants/storage-entities.js';
import type { LazyArray } from '../utilities/lazy-array.js';
import type { DeepReadonly } from '../utilities/object.js';

export type StorageStructureKind<T> = Record<string, T>;

export type WritableStorageStructure<T> =
  Record<StorageEntityKind, StorageStructureKind<T>>;

export type StorageStructure<T, TDeep extends number = 2> =
  DeepReadonly<WritableStorageStructure<T>, TDeep>;

export type StorageItemValues = Partial<StorageStructure<unknown>>;

export type StorageAccessors = StorageStructure<LazyArray, 3>;

export interface StorageChunkSet {
  level: number;

  start: number;
  end: number;
  size: number;

  startedAt: number;
  endedAt: number;

  chunks: StorageChunks;
}

export type StorageChunks = StorageStructure<StorageChunk>;

export interface StorageChunk {
  data: Uint8Array;
  view: DataView;
}

export interface StorageChunkAndPosition extends StorageChunk {
  itemIndex: number;
}

export type GetChunkAndPosByFlatIndex = (
  kind: StorageEntityKind,
  name: string,
  flatIndex: number,
) => StorageChunkAndPosition;

export interface StoragePersistenceSnapshot {
  marketName: string;
  startedAt: number;
  endedAt: number;
  data: Uint8Array;
}

export interface ExtendedStoragePersistenceSnapshot
  extends StoragePersistenceSnapshot {
  snapshotType: 'active' | 'archive';
}

export type SnapshotTypes = 'both snapshots' | 'archive snapshot only';
