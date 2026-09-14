// app/src/shared/services/storage-config.ts

import {
  DAYS,
  HOUR,
  HOURS,
  MINUTE,
  MINUTES,
  SECONDS,
  WEEK,
} from '../constants/time';
import type {
  ExtendedStorageLevelConfig,
  StorageLevelConfig,
  StorageLevelConfigDefinition,
} from '../types/storage-config';
import {
  STORAGE_CHUNK_CAPACITY,
} from '../constants/storage-config.js';

const STORAGE_LEVELS_CONFIGS = [
  {
    duration: 1 * SECONDS,
    interval: 10 * MINUTES,
  },
  {
    duration: 10 * SECONDS,
    interval: 1 * HOUR + 20 * MINUTES,
  },
  {
    duration: 1 * MINUTE,
    interval: 5 * HOURS + 30 * MINUTES,
  },
  {
    duration: 10 * MINUTES,
    interval: 18 * HOURS,
  },
  {
    duration: 1 * HOUR,
    interval: 1 * WEEK + 6 * DAYS,
  },
] as const satisfies readonly StorageLevelConfigDefinition[];

class StorageConfig {
  private config: ExtendedStorageLevelConfig[];

  public constructor() {
    if (
      !Number.isSafeInteger(STORAGE_CHUNK_CAPACITY) ||
      STORAGE_CHUNK_CAPACITY <= 0 ||
      STORAGE_CHUNK_CAPACITY > 0xff
    ) {
      throw new RangeError(
        `Invalid STORAGE_CHUNK_CAPACITY: ${STORAGE_CHUNK_CAPACITY}`,
      );
    }

    let retentionDepth = 0;

    this.config = STORAGE_LEVELS_CONFIGS.map(
      (item, index) => {
        retentionDepth += item.interval;
        return {
          ...item,
          level: index,
          cumulativeInterval: retentionDepth,
        };
      },
    );
  }

  public get numberOfLevels(): number {
    return this.config.length;
  }

  public get maxLevel(): number {
    return this.config.length - 1;
  }

  public getLevelConfig(level: number): StorageLevelConfig {
    const levelConfig = this.config[level];

    if (!levelConfig) {
      throw new RangeError(`Level ${level} not found in config`);
    }

    return {
      ...levelConfig,
      cutoff: Date.now() - levelConfig.cumulativeInterval,
    };
  }
}

export const storageConfig = new StorageConfig();
