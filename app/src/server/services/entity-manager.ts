// app/src/server/services/entity-manager.ts

import {
  STORAGE_ENTITY_KINDS,
  StorageEntityKind,
} from '../../shared/constants/storage-entities.js';
import { entityBinaryCodec } from '../../shared/utilities/codecs/codecs.js';
import { entities } from '../entities/index.js';
import type { Entity, Entities } from '../types/entities.js';
import type { RecalculateEntitiesRequestEvent } from '../types/events.js';
import { SERVER_EVENT } from '../constants/events.js';
import { eventBus } from './event-bus.js';

export class EntityManager {
  private readonly entities: Entities;

  public constructor() {
    this.entities = Object.fromEntries(
      Object.entries(entities).map(([kind, kindEntities]) => [
        kind,
        this.sortEntities(kind as StorageEntityKind, kindEntities),
      ]),
    ) as Entities;
  }

  public start(): void {
    for (const kind of STORAGE_ENTITY_KINDS) {
      const kindEntities = this.entities[kind];

      for (const { descriptor } of kindEntities) {
        entityBinaryCodec(descriptor.codec);
      }

      eventBus.emit(
        SERVER_EVENT.addStorageEntities,
        {
          entities: kindEntities.map(({ descriptor }) => descriptor),
        },
      );
    }

    eventBus.on(
      SERVER_EVENT.recalculateEntitiesRequest,
      (event) => { this.handleRecalculateEntitiesRequest(event); },
    );

    eventBus.on(
      SERVER_EVENT.marketRemoved,
      (event) => { this.handleMarketRemoved(event.marketName); },
    );
  }

  private handleRecalculateEntitiesRequest(
    event: RecalculateEntitiesRequestEvent,
  ): void {
    for (const kind of STORAGE_ENTITY_KINDS) {
      for (const entity of this.entities[kind]) {
        entity.calculate(event.accessors, event.marketName);
      }
    }

    eventBus.emit(
      SERVER_EVENT.entitiesRecalculated,
      {
        marketName: event.marketName,
        size: event.size,
        endedAt: event.endedAt,
      },
    );
  }

  private handleMarketRemoved(marketName: string): void {
    for (const kind of STORAGE_ENTITY_KINDS) {
      for (const entity of this.entities[kind]) {
        entity.removeMarket(marketName);
      }
    }
  }

  private sortEntities(
    kind: StorageEntityKind,
    entities: readonly Entity[],
  ): Entity[] {
    const sorted: Entity[] = [];
    const permanent = new Set<string>();
    const temporary = new Set<string>();

    const byName = new Map(
      entities.map((entity) => [entity.descriptor.name, entity]),
    );

    const visit = (entity: Entity): void => {
      const name = entity.descriptor.name;

      if (entity.descriptor.kind !== kind) {
        throw new Error(
          `Entity "${name}" belongs to "${entity.descriptor.kind}", ` +
          `but was registered in "${kind}"`,
        );
      }

      if (permanent.has(name)) {
        return;
      }

      if (temporary.has(name)) {
        throw new Error(`Circular ${kind} dependency: ${name}`);
      }

      temporary.add(name);

      for (const dependency of entity.dependencies) {
        const dependencyEntity = byName.get(dependency);

        if (!dependencyEntity) {
          throw new Error(
            `${kind} entity "${name}" depends on unknown entity ` +
            `"${dependency}"`,
          );
        }

        visit(dependencyEntity);
      }

      temporary.delete(name);
      permanent.add(name);
      sorted.push(entity);
    };

    for (const entity of entities) {
      visit(entity);
    }

    return sorted;
  }
}

export const entityManager = new EntityManager();
