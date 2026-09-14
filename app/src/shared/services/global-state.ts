// app/src/shared/services/global-state.ts

import {
  STORAGE_ENTITY_KINDS,
  type StorageEntityKind,
} from '../constants/storage-entities.js';
import type { MarketsByName } from '../types/market.js';
import type {
  EntityDescriptors,
  EntityDesriptor,
  KindEntityDescriptors,
} from '../types/storage-entities.js';
import type {
  StorageStructure,
  WritableStorageStructure,
} from '../types/storage.js';
import { deepFreeze } from '../utilities/object.js';

type StorageEntitiesListener = (
  entities: EntityDesriptor[] | null,
) => void;

type MarketsListener = (
  markets: MarketsByName | null,
  marketNames: readonly string[] | null,
) => void;

export class GlobalStateService {
  private storageEntities: EntityDesriptor[] = [];

  private storageEntitiesStructure:
    StorageStructure<EntityDesriptor, number> | null = null;

  private isStorageEntitiesReady = false;

  private storageEntitiesPromise: Promise<EntityDesriptor[]> | null = null;

  private resolveStorageEntities:
    ((entities: EntityDesriptor[]) => void) | null = null;

  private readonly storageEntitiesListeners =
    new Set<StorageEntitiesListener>();

  private marketsByName: MarketsByName | null = null;

  private marketNames: string[] | null = null;

  private marketsPromise:
    Promise<MarketsByName> | null = null;

  private resolveMarkets:
    ((markets: MarketsByName) => void) | null = null;

  private readonly marketsListeners = new Set<MarketsListener>();

  public addStorageEntities(
    entities: readonly EntityDesriptor[],
  ): void {
    for (const entity of entities) {
      if (
        this.storageEntities.some(
          (storedEntity) =>
            storedEntity.kind === entity.kind &&
            storedEntity.name === entity.name,
        )
      ) {
        throw new Error(
          `Storage entity "${entity.kind}:${entity.name}" is already registered`,
        );
      }

      this.storageEntities.push({ ...entity });
    }

    this.isStorageEntitiesReady =
      STORAGE_ENTITY_KINDS.every(
        (kind) => this.storageEntities.some((entity) => entity.kind === kind),
      );

    if (!this.isStorageEntitiesReady) {
      return;
    }

    this.storageEntitiesStructure = this.mapStorageEntities(
      (entity) => entity,
    );

    this.resolveStorageEntities?.(this.storageEntities);

    this.resolveStorageEntities = null;
    this.storageEntitiesPromise = null;

    this.notifyStorageEntitiesListeners();
  }

  public getStorageEntities(): EntityDesriptor[] {
    return this.storageEntities;
  }

  public getStorageEntitiesOrNull(): EntityDesriptor[] | null {
    return this.isStorageEntitiesReady
      ? this.getStorageEntities()
      : null;
  }

  public hasStorageEntities(): boolean {
    return this.isStorageEntitiesReady;
  }

  public getStorageEntitiesWithPreservedHistory():
    readonly EntityDesriptor[] {
    if (!this.isStorageEntitiesReady) {
      return [];
    }

    return this.storageEntities.filter(
      (entity) => entity.requiresRemovedValues,
    );
  }

  public waitForStorageEntities(): Promise<EntityDesriptor[]> {
    if (this.isStorageEntitiesReady) {
      return Promise.resolve(this.getStorageEntities());
    }

    if (!this.storageEntitiesPromise) {
      this.storageEntitiesPromise = new Promise((resolve) => {
        this.resolveStorageEntities = resolve;
      });
    }

    return this.storageEntitiesPromise;
  }

  public subscribeStorageEntities(
    listener: StorageEntitiesListener,
  ): () => void {
    this.storageEntitiesListeners.add(listener);

    listener(this.getStorageEntitiesOrNull());

    return () => {
      this.storageEntitiesListeners.delete(listener);
    };
  }

  public clearStorageEntities(): void {
    this.storageEntities = [];
    this.storageEntitiesStructure = null;
    this.isStorageEntitiesReady = false;

    this.storageEntitiesPromise = null;
    this.resolveStorageEntities = null;

    this.notifyStorageEntitiesListeners();
  }

  public mapStorageEntities<T, TDeep extends number = 2>(
    mapper: (entity: EntityDesriptor, index: number) => T,
    freezeDeep: TDeep = 2 as TDeep,
  ): StorageStructure<T, TDeep> {
    if (!this.isStorageEntitiesReady) {
      throw new Error('Storage entities are not initialized');
    }

    const result = {} as WritableStorageStructure<T>;

    for (const kind of STORAGE_ENTITY_KINDS) {
      result[kind] = {};
    }

    for (const [index, entity] of this.storageEntities.entries()) {
      result[entity.kind][entity.name] = mapper(entity, index);
    }

    return deepFreeze(result, freezeDeep);
  }

  public getStorageEntitiesStructure(): EntityDescriptors;
  public getStorageEntitiesStructure(
    kind: StorageEntityKind,
  ): KindEntityDescriptors;
  public getStorageEntitiesStructure(
    kind?: StorageEntityKind,
  ): EntityDescriptors | KindEntityDescriptors {
    if (this.storageEntitiesStructure === null) {
      throw new Error('Storage entities are not initialized');
    }

    return kind
      ? this.storageEntitiesStructure[kind]
      : this.storageEntitiesStructure;
  }

  public setMarkets(
    markets: MarketsByName,
    marketNames: readonly string[],
  ): void {
    const storedMarkets = structuredClone(markets);
    const storedMarketNames = [...marketNames];

    this.marketsByName = storedMarkets;
    this.marketNames = storedMarketNames;

    this.resolveMarkets?.(storedMarkets);

    this.resolveMarkets = null;
    this.marketsPromise = null;

    this.notifyMarketsListeners();
  }

  public getMarkets(): MarketsByName {
    if (!this.marketsByName) {
      throw new Error('Markets are not initialized');
    }

    return structuredClone(this.marketsByName);
  }

  public getMarketsOrNull(): MarketsByName | null {
    return this.marketsByName
      ? structuredClone(this.marketsByName)
      : null;
  }

  public getMarketNames(): string[] | null {
    return this.marketNames
      ? [...this.marketNames]
      : null;
  }

  public hasMarkets(): boolean {
    return this.marketsByName !== null;
  }

  public waitForMarkets(): Promise<MarketsByName> {
    if (this.marketsByName) {
      return Promise.resolve(
        structuredClone(this.marketsByName),
      );
    }

    if (!this.marketsPromise) {
      this.marketsPromise = new Promise((resolve) => {
        this.resolveMarkets = resolve;
      });
    }

    return this.marketsPromise;
  }

  public subscribeMarkets(
    listener: MarketsListener,
  ): () => void {
    this.marketsListeners.add(listener);

    listener(this.getMarketsOrNull(), this.getMarketNames() );

    return () => { this.marketsListeners.delete(listener); };
  }

  public clearMarkets(): void {
    this.marketsByName = null;
    this.marketNames = null;

    this.marketsPromise = null;
    this.resolveMarkets = null;

    this.notifyMarketsListeners();
  }

  private notifyStorageEntitiesListeners(): void {
    for (const listener of this.storageEntitiesListeners) {
      listener(this.getStorageEntitiesOrNull());
    }
  }

  private notifyMarketsListeners(): void {
    for (const listener of this.marketsListeners) {
      listener(
        this.getMarketsOrNull(),
        this.getMarketNames(),
      );
    }
  }
}

export const globalStateService = new GlobalStateService();
