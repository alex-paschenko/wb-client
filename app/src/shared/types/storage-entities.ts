// app/src/shared/types/storage-entities.ts

import type { StorageEntityKind } from '../constants/storage-entities.js';
import type { EntityCodecName } from '../utilities/codecs/definitions/index.js';
import type { StorageStructure, StorageStructureKind } from './storage.js';

export type LineStyle = 'price';

export interface LineDataDescriptor {
  kind: 'line';
  group: string;
  key?: string;
  style?: LineStyle;
}

export interface OhlcDataDescriptor {
  kind: 'ohlc';
  group: string;
  key?: never;
  style?: never;
}

export type EntityDataDescriptor =
  | LineDataDescriptor
  | OhlcDataDescriptor;

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
