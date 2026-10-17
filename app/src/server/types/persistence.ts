// app/src/server/types/persistence.ts

import type {
  StorageEntityKind,
} from '../../shared/constants/storage-entities.js';
import type {
  StorageChunk,
  StorageChunkSet,
} from '../../shared/types/storage.js';
import type { StrategyStateChange } from './strategies.js';

export interface StorageChunkRow
  extends Omit<StorageChunk, 'view'> {
  chunkSetId: number;
  kind: StorageEntityKind;
  name: string;
  isActive: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export interface StorageChunkSetRow
  extends Omit<StorageChunkSet, 'chunks'> {
  serverId: number;
  marketName: string;
  isActive: boolean;
  chunks: StorageChunkRow[];
}

export type ActiveStorageChunkSetPersistenceChange =
  StorageChunkSetRow & { isActive: true; };


export interface StoragePersistenceSnapshot {
  marketName: string;
  startedAt: number;
  endedAt: number;
  data: Uint8Array;
}

export interface DepthPersistence {
  marketName: string;
  data: Uint8Array;
  startReceivedAt: number;
}

export interface StrategyStateChangePersistence extends StrategyStateChange<string> {
  marketName: string;
  strategyName: string;
}
