// app/src/shared/constants/storage-entities.ts

export const STORAGE_ENTITY_KINDS = [
  'candles',
  'indicators',
] as const;

export type StorageEntityKind = typeof STORAGE_ENTITY_KINDS[number];

export const CANDLE_NAME = 'candle';

export const ENTITY_DATA_KIND = [
  'line',
  'ohlc',
  'priceLine',
  'speedLine',
  'accelerationLine',
] as const;

export type EntityDataKind = typeof ENTITY_DATA_KIND[number];
