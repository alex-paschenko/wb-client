// app/src/shared/constants/storage-entities.ts

export const STORAGE_ENTITY_KINDS = [
  'candles',
  'indicators',
] as const;

export type StorageEntityKind = typeof STORAGE_ENTITY_KINDS[number];

export const CANDLE_NAME = 'candle';
