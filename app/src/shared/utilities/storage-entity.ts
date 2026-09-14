// app/src/shared/utilities/storage-entity.ts

import {
  STORAGE_ENTITY_KINDS,
  type StorageEntityKind
} from '../constants/storage-entities';

export const isStorageEntityKind = (
  value: string,
): value is StorageEntityKind =>
  STORAGE_ENTITY_KINDS.some((kind) => kind === value);

export function validateEntityKind(
  value: string,
): asserts value is StorageEntityKind {
  if (!isStorageEntityKind(value)) {
    throw new TypeError(`Unknown Entity kind: "${value}"`);
  }
}
