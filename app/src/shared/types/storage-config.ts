// app/src/shared/types/storage-config.ts

export interface StorageLevelConfigDefinition {
  duration: number;
  interval: number;
}

export interface StorageLevelConfig
  extends StorageLevelConfigDefinition {
  level: number;
  maxCount: number;
}
