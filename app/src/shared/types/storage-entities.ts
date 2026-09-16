// app/src/shared/types/storage-entities.ts

import type {
  StorageEntityKind,
  EntityDataKind,
} from '../constants/storage-entities.js';
import type { EntityCodecName } from '../utilities/codecs/definitions/index.js';
import type { StorageStructure, StorageStructureKind } from './storage.js';


export interface EntityDataDescriptor {
  kind: EntityDataKind;
  group: string;
  key?: string;
}

export interface EntityDesriptor<T = unknown> {
  kind: StorageEntityKind;
  name: string;
  codec: EntityCodecName;
  data: readonly EntityDataDescriptor[];
  requiresRemovedValues: boolean;
  empty: T;
}

export type EntityDescriptors = StorageStructure<EntityDesriptor>;
export type KindEntityDescriptors = StorageStructureKind<EntityDesriptor>;