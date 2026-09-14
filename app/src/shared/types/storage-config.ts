// app/src/shared/types/storage-config.ts

export interface StorageLevelConfigDefinition {
  duration: number;
  interval: number;
}

export interface ExtendedStorageLevelConfig
    extends StorageLevelConfigDefinition {
      cumulativeInterval: number;
      level: number;
    }

export interface StorageLevelConfig extends ExtendedStorageLevelConfig {
  cutoff: number;
}
