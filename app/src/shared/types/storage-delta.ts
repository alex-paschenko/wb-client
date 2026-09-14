// app/src/shared/types/storage-delta.ts

import type { StorageEntityKind } from '../constants/storage-entities.js';
import type { StorageChunkSet } from './storage.js';

export interface StorageDeltaParams {
  size: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface StorageStructuralAddItemChange {
  type: 'addItem';
  level: number;
  startedAt: number;
  endedAt: number;
}

export interface StorageStructuralDeleteItemsChange {
  type: 'deleteItems';
  level: number;
  count: number;
  newStartedAt: number | null;
}

export type StorageStructuralChange =
  | StorageStructuralAddItemChange
  | StorageStructuralDeleteItemsChange;

export interface StorageDeltaChunkInterval {
  chunkSetIndex: number;
  startItemIndex: number;
  itemsCount: number;
}

export interface StorageDeltaEntityChanges {
  entityKind: StorageEntityKind;
  entityName: string;
  entityIndex: number;
  changes: StorageDeltaChunkInterval[];
}

export interface StorageDeltaCodecData {
  flags: number;
  startParams: StorageDeltaParams;
  endParams: StorageDeltaParams;
  structuralChanges: readonly StorageStructuralChange[];
  entityChanges: readonly StorageDeltaEntityChanges[];
}

export interface StorageDeltaApplyResult {
  appendOnly: boolean;
}

export interface StorageBuiltDeltaChanges {
  entityChanges: StorageDeltaEntityChanges[];
  appendOnly: boolean;
}

export interface StorageDeltaCodecAccumulator {
  getCurrentParams: () => StorageDeltaParams;
  getChunkSets: () => readonly StorageChunkSet[];
  applyStructuralChanges: (
    changes: readonly StorageStructuralChange[],
  ) => void;
}

export type StorageDeltaMode = 'allow' | 'restrict';
