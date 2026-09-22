// app/src/shared/types/storage-snapshot.ts

import type { StorageEntityKind } from '../constants/storage-entities.js';
import type { EntityDesriptor } from './storage-entities.js';

export interface StorageSnapshotEntity {
  kind: StorageEntityKind;
  name: string;
  codec: string;
  itemSize: number;
}

export interface StorageSnapshotGlobalHeader {
  entities: StorageSnapshotEntity[];
}

export interface StorageSnapshotChunkSetHeader {
  level: number;
  size: number;
  startedAt: number;
  endedAt: number;
}

export interface StorageSnapshotCodecAccumulator {
  entities: readonly EntityDesriptor[];
}
