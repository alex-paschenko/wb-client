// app/src/server/types/events.ts

import type { EntityDesriptor } from '../../shared/types/storage-entities.js';
import type {
  MarketRollingStatistics,
  MarketRollingStatisticsByMarket,
} from '../../shared/types/market-statistics-rolling.js';
import type { SERVER_EVENT } from '../constants/events.js';
import type { MarketTick } from './market-statistics.js';
import type { MarketsByName } from '../../shared/types/market.js';
import {
  ExtendedStoragePersistenceSnapshot,
  StorageAccessors,
} from '../../shared/types/storage.js';

export type ServerEventName =
  typeof SERVER_EVENT[keyof typeof SERVER_EVENT];

export interface MarketsInfoUpdatedEvent {
  markets: MarketsByName;
  marketNames: string[];
}

export interface MarketRollingTickReceivedEvent {
  marketName: string;
  rollingStatistics: MarketRollingStatistics;
}

export interface MarketRollingUpdatedEvent {
  rollingStatisticsByMarket: MarketRollingStatisticsByMarket;
}

export interface MarketTickReceivedEvent {
  marketName: string;
  tick: MarketTick;
}

export interface RecalculateEntitiesRequestEvent {
  accessors: StorageAccessors;
  marketName: string;
  size: number;
  endedAt: number;
}

export interface EntitiesRecalculatedEvent {
  marketName: string;
  size: number;
  endedAt: number;
}

export interface StorageSnapshotedEvent {
  snapshots: ExtendedStoragePersistenceSnapshot[];
}

export interface StorageDeltaCreatedEvent {
  data: Uint8Array<ArrayBufferLike>;
  marketName: string;
}

export interface StorageFullSyncRequestEvent {
  marketName: string;
  eventId: number;
}

export interface StorageFullSyncResultsEvent {
  marketName: string;
  eventId: number;
  data: Uint8Array<ArrayBufferLike>;
}

export interface AddStorageEntitiesEvent {
  entities: EntityDesriptor[];
}

export interface MarketRemovedEvent {
  marketName: string;
}

export interface ServerEventMap {
  [SERVER_EVENT.marketsInfoUpdated]: MarketsInfoUpdatedEvent;

  [SERVER_EVENT.marketRemoved]: MarketRemovedEvent;

  [SERVER_EVENT.marketRollingTickReceived]: MarketRollingTickReceivedEvent;
  [SERVER_EVENT.marketRollingUpdated]: MarketRollingUpdatedEvent;

  [SERVER_EVENT.marketTickReceived]: MarketTickReceivedEvent;

  [SERVER_EVENT.addStorageEntities]: AddStorageEntitiesEvent;
  [SERVER_EVENT.recalculateEntitiesRequest]: RecalculateEntitiesRequestEvent;
  [SERVER_EVENT.entitiesRecalculated]: EntitiesRecalculatedEvent;

  [SERVER_EVENT.storageSnapshoted]: StorageSnapshotedEvent;
  [SERVER_EVENT.storageDeltaCreated]:StorageDeltaCreatedEvent;
  [SERVER_EVENT.storageFullSyncRequest]: StorageFullSyncRequestEvent;
  [SERVER_EVENT.storageFullSyncResults]: StorageFullSyncResultsEvent;
}
