// app/src/server/types/entities.ts

import type { StorageEntityKind } from '../../shared/constants/storage-entities.js';
import type { StorageAccessors } from '../../shared/types/storage.js';
import type { EntityDesriptor } from '../../shared/types/storage-entities.js';

export interface Entity<T = unknown> {
  readonly descriptor: EntityDesriptor<T>;
  readonly dependencies: readonly string[];

  calculate(accessors: StorageAccessors, marketName: string): void;
  removeMarket(marketName: string): void;
}

export type Entities = {
  [K in StorageEntityKind]: Entity[];
};

export interface EntityAffectedRange {
  startIndex: number;
  endIndex: number;
}
