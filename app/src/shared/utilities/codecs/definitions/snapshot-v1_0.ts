// app/src/shared/utilities/codecs/definitions/snapshot-v1_0.ts

import { STORAGE_CHUNK_CAPACITY } from '../../../constants/storage-config';
import {
  STORAGE_ENTITY_KINDS,
  type StorageEntityKind,
} from '../../../constants/storage-entities';
import { globalStateService } from '../../../services/global-state';
import type { FixedSizeCodec, SingleValueCodec } from '../../../types/codecs';
import type { StorageChunk, StorageChunks, StorageChunkSet } from '../../../types/storage';
import type { EntityDesriptor } from '../../../types/storage-entities';
import { singleValueCodecDefinition } from './codec-definition-helpers';
import { getCodec } from '../codecs';
import { FLOAT64_SIZE, UINT16_SIZE, UINT32_SIZE, UINT8_SIZE } from './general-constants';
import type { StorageSnapshotCodecAccumulator } from '../../../types/storage-snapshot';

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

export const snapshot_V1_0 = singleValueCodecDefinition<
  { chunkSets: StorageChunkSet[]; },
  StorageSnapshotCodecAccumulator
>(
  (() => {
    interface EntityDescriptor {
      kind: string;
      name: string;
      codec: string;
      itemSize: number;
    }

    interface EntityRestorePlan {
      descriptor: EntityDescriptor;
      entity: EntityDesriptor | null;
      targetCodec: FixedSizeCodec | null;
      sourceCodec: FixedSizeCodec | null;
    }

    interface MissingEntityRestorePlan {
      entity: EntityDesriptor;
      codec: FixedSizeCodec;
    }

    interface RestorePlan {
      entities: EntityRestorePlan[];
      missingEntities: MissingEntityRestorePlan[];
    }

    const CHUNK_SET_HEADER_SIZE = UINT8_SIZE + UINT16_SIZE + FLOAT64_SIZE * 2;

    const getStringCodec = (): SingleValueCodec<string, any> => {
      const codec = getCodec('string (2^16) v1.0');

      if (codec.dataKind !== 'singleValue') {
        throw new TypeError(
          `Codec "string (2^16) v1.0" must be singleValue`,
        );
      }

      return codec;
    };

    const getFixedSizeCodec = (
      name: string,
      context: string,
    ): FixedSizeCodec => {
      const codec = getCodec(name);

      if (
        codec.dataKind !== 'primitive' &&
        codec.dataKind !== 'fixedCountArray'
      ) {
        throw new TypeError(
          `${context} uses variable-size codec "${name}"`,
        );
      }

      return codec;
    };

    const getCurrentKind = (
      kind: string,
    ): StorageEntityKind | null =>
      STORAGE_ENTITY_KINDS.find(
        (currentKind) => currentKind === kind,
      ) ?? null;

    const ensureAvailable = (
      offset: number,
      byteLength: number,
      view: DataView,
      context: string,
    ): void => {
      if (
        offset < 0 ||
        byteLength < 0 ||
        offset + byteLength > view.byteLength
      ) {
        throw new RangeError(`${context} exceeds snapshot size`);
      }
    };

    const getAccumulator = (
      accumulator:
        StorageSnapshotCodecAccumulator | null,
    ): StorageSnapshotCodecAccumulator => {
      if (!accumulator) {
        throw new Error(
          'Storage snapshot codec requires an accumulator',
        );
      }

      return accumulator;
    };

    const getEntityDescriptors = (
      entities: readonly EntityDesriptor[],
    ): EntityDescriptor[] =>
      entities.map((entity) => {
        const codec = getFixedSizeCodec(
          entity.codec,
          `Storage entity "${entity.kind}:${entity.name}"`,
        );

        if (codec.size > 0xffff) {
          throw new RangeError(
            `Item size ${codec.size} of storage entity ` +
            `"${entity.kind}:${entity.name}" exceeds uint16 range`,
          );
        }

        return {
          kind: entity.kind,
          name: entity.name,
          codec: entity.codec,
          itemSize: codec.size,
        };
      });

    const getEntityDescriptorSize = (
      descriptor: EntityDescriptor,
    ): number => {
      const stringCodec = getStringCodec();

      return (
        stringCodec.getSize(descriptor.kind) +
        stringCodec.getSize(descriptor.name) +
        stringCodec.getSize(descriptor.codec) +
        UINT16_SIZE
      );
    };

    const writeEntityDescriptor = (
      offset: number,
      view: DataView,
      descriptor: EntityDescriptor,
    ): number => {
      const stringCodec = getStringCodec();

      offset = stringCodec.writeByOffset(
        offset,
        view,
        descriptor.kind,
      ).nextOffset;

      offset = stringCodec.writeByOffset(
        offset,
        view,
        descriptor.name,
      ).nextOffset;

      offset = stringCodec.writeByOffset(
        offset,
        view,
        descriptor.codec,
      ).nextOffset;

      view.setUint16(offset, descriptor.itemSize, true);

      return offset + UINT16_SIZE;
    };

    const readEntityDescriptor = (
      offset: number,
      view: DataView,
    ): {
      value: EntityDescriptor;
      nextOffset: number;
    } => {
      const stringCodec = getStringCodec();

      const kindResult =
        stringCodec.readByOffset(offset, view);

      const nameResult =
        stringCodec.readByOffset(kindResult.nextOffset, view);

      const codecResult =
        stringCodec.readByOffset(nameResult.nextOffset, view);

      offset = codecResult.nextOffset;

      ensureAvailable(offset, UINT16_SIZE, view, 'Entity item size');

      const itemSize = view.getUint16(offset, true);

      if (itemSize === 0) {
        throw new RangeError(
          `Storage entity "${kindResult.value}:` +
          `${nameResult.value}" has zero item size`,
        );
      }

      return {
        value: {
          kind: kindResult.value,
          name: nameResult.value,
          codec: codecResult.value,
          itemSize,
        },
        nextOffset: offset + UINT16_SIZE,
      };
    };

    const getEntityDescriptorsSize = (
      descriptors: readonly EntityDescriptor[],
    ): number => {
      if (descriptors.length > 0xffff) {
        throw new RangeError(
          `Storage entity count ${descriptors.length} exceeds uint16 range`,
        );
      }

      let size = UINT16_SIZE;

      for (const descriptor of descriptors) {
        size += getEntityDescriptorSize(descriptor);
      }

      return size;
    };

    const writeEntityDescriptors = (
      offset: number,
      view: DataView,
      descriptors: readonly EntityDescriptor[],
    ): number => {
      if (descriptors.length > 0xffff) {
        throw new RangeError(
          `Storage entity count ${descriptors.length} exceeds uint16 range`,
        );
      }

      view.setUint16(offset, descriptors.length, true);
      offset += UINT16_SIZE;

      for (const descriptor of descriptors) {
        offset = writeEntityDescriptor(offset, view, descriptor);
      }

      return offset;
    };

    const readEntityDescriptors = (
      offset: number,
      view: DataView,
    ): { value: EntityDescriptor[]; nextOffset: number; } => {
      ensureAvailable(offset, UINT16_SIZE, view, 'Entity descriptor count');

      const count = view.getUint16(offset, true);
      offset += UINT16_SIZE;

      const descriptors: EntityDescriptor[] = [];
      const entityNames = new Set<string>();

      for (let index = 0; index < count; index++) {
        const result = readEntityDescriptor(offset, view);

        const descriptor = result.value;
        const entityName = `${descriptor.kind}\u0000${descriptor.name}`;

        if (entityNames.has(entityName)) {
          throw new Error(
            `Duplicate storage entity ` +
            `"${descriptor.kind}:${descriptor.name}" in snapshot`,
          );
        }

        entityNames.add(entityName);
        descriptors.push(descriptor);
        offset = result.nextOffset;
      }

      return { value: descriptors, nextOffset: offset };
    };

    const validateChunkSet = (
      chunkSet: StorageChunkSet,
    ): void => {
      if (
        !Number.isInteger(chunkSet.level) ||
        chunkSet.level < 0 ||
        chunkSet.level > 0xff
      ) {
        throw new RangeError(
          `Storage level ${chunkSet.level} exceeds uint8 range`,
        );
      }

      if (
        !Number.isInteger(chunkSet.start) ||
        !Number.isInteger(chunkSet.end) ||
        !Number.isInteger(chunkSet.size) ||
        chunkSet.start < 0 ||
        chunkSet.end < chunkSet.start ||
        chunkSet.end > STORAGE_CHUNK_CAPACITY ||
        chunkSet.size !== chunkSet.end - chunkSet.start
      ) {
        throw new RangeError(
          `Invalid storage chunk set geometry: ` +
          `start=${chunkSet.start}, end=${chunkSet.end}, ` +
          `size=${chunkSet.size}`,
        );
      }
    };

    const getChunkSetSize = (
      chunkSet: StorageChunkSet,
      descriptors: readonly EntityDescriptor[],
    ): number => {
      validateChunkSet(chunkSet);

      let size = CHUNK_SET_HEADER_SIZE;

      for (const descriptor of descriptors) {
        size += chunkSet.size * descriptor.itemSize;
      }

      return size;
    };

    const writeChunkSet = (
      offset: number,
      view: DataView,
      chunkSet: StorageChunkSet,
      descriptors: readonly EntityDescriptor[],
    ): number => {
      validateChunkSet(chunkSet);

      view.setUint8(offset, chunkSet.level);
      offset += UINT8_SIZE;

      view.setUint16(offset, chunkSet.size, true);
      offset += UINT16_SIZE;

      view.setFloat64(offset, chunkSet.startedAt, true);
      offset += FLOAT64_SIZE;

      view.setFloat64(offset, chunkSet.endedAt, true);
      offset += FLOAT64_SIZE;

      for (const descriptor of descriptors) {
        const kind = getCurrentKind(descriptor.kind);

        if (kind === null) {
          throw new Error(
            `Current storage entity kind "${descriptor.kind}" not found`,
          );
        }

        const chunk = chunkSet.chunks[kind][descriptor.name];

        if (!chunk) {
          throw new Error(
            `Chunk for storage entity ` +
            `"${descriptor.kind}:${descriptor.name}" not found`,
          );
        }

        const expectedChunkSize = STORAGE_CHUNK_CAPACITY * descriptor.itemSize;

        if (chunk.data.byteLength !== expectedChunkSize) {
          throw new RangeError(
            `Chunk for storage entity ` +
            `"${descriptor.kind}:${descriptor.name}" has ` +
            `${chunk.data.byteLength} bytes, expected ` +
            `${expectedChunkSize}`,
          );
        }

        const from = chunkSet.start * descriptor.itemSize;

        const to = chunkSet.end * descriptor.itemSize;

        const source = chunk.data.subarray(from, to);

        new Uint8Array(
          view.buffer,
          view.byteOffset + offset,
          source.byteLength,
        ).set(source);

        offset += source.byteLength;
      }

      return offset;
    };

    const createChunks = (): StorageChunks =>
      globalStateService.mapStorageEntities((entity) => {
        const codec = getFixedSizeCodec(
          entity.codec,
          `Storage entity "${entity.kind}:${entity.name}"`,
        );

        const data = new Uint8Array(STORAGE_CHUNK_CAPACITY * codec.size);

        return {
          data,
          view: new DataView(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          ),
        } satisfies StorageChunk;
      });

    const buildRestorePlan = (
      descriptors: readonly EntityDescriptor[],
    ): RestorePlan => {
      const currentEntities = globalStateService.getStorageEntities();

      const currentStructure = globalStateService.getStorageEntitiesStructure();

      const matchedEntities = new Set<EntityDesriptor>();
      const entities: EntityRestorePlan[] = [];

      for (const descriptor of descriptors) {
        const kind = getCurrentKind(descriptor.kind);

        if (kind === null) {
          entities.push(
            { descriptor, entity: null, targetCodec: null, sourceCodec: null }
          );

          continue;
        }

        const entity = currentStructure[kind][descriptor.name] ?? null;

        if (entity === null) {
          entities.push(
            { descriptor, entity: null, targetCodec: null, sourceCodec: null }
          );

          continue;
        }

        const targetCodec = getFixedSizeCodec(
          entity.codec,
          `Storage entity "${entity.kind}:${entity.name}"`,
        );

        matchedEntities.add(entity);

        if (descriptor.codec === entity.codec) {
          if (targetCodec.size !== descriptor.itemSize) {
            throw new RangeError(
              `Stored item size ${descriptor.itemSize} does not ` +
              `match codec "${descriptor.codec}" size ` +
              `${targetCodec.size}`,
            );
          }

          entities.push(
            { descriptor, entity, targetCodec, sourceCodec: null }
          );

          continue;
        }

        const sourceCodec = getFixedSizeCodec(
          descriptor.codec,
          `Stored entity "${descriptor.kind}:${descriptor.name}"`,
        );

        if (sourceCodec.size !== descriptor.itemSize) {
          throw new RangeError(
            `Stored item size ${descriptor.itemSize} does not ` +
            `match codec "${descriptor.codec}" size ` +
            `${sourceCodec.size}`,
          );
        }

        if (!targetCodec.migrate) {
          throw new Error(
            `Codec "${entity.codec}" cannot migrate ` +
            `storage entity "${entity.kind}:${entity.name}" ` +
            `from "${descriptor.codec}"`,
          );
        }

        entities.push(
          { descriptor, entity, targetCodec, sourceCodec });
      }

      const missingEntities: MissingEntityRestorePlan[] = [];

      for (const entity of currentEntities) {
        if (matchedEntities.has(entity)) {
          continue;
        }

        missingEntities.push({
          entity,
          codec: getFixedSizeCodec(
            entity.codec,
            `Storage entity "${entity.kind}:${entity.name}"`,
          ),
        });
      }

      return { entities, missingEntities };
    };

    const restoreEntity = (
      offset: number,
      view: DataView,
      size: number,
      chunks: StorageChunks,
      plan: EntityRestorePlan,
    ): number => {
      const { descriptor, entity, targetCodec, sourceCodec } = plan;

      const byteLength = size * descriptor.itemSize;

      ensureAvailable(
        offset,
        byteLength,
        view,
        `Storage entity "${descriptor.kind}:${descriptor.name}" data`,
      );

      if ( entity === null || targetCodec === null ) {
        return offset + byteLength;
      }

      const chunk = chunks[entity.kind][entity.name];

      if (sourceCodec === null) {
        chunk.data.set(
          new Uint8Array(view.buffer, view.byteOffset + offset, byteLength),
        );

        return offset + byteLength;
      }

      const migrate = targetCodec.migrate;

      if (!migrate) {
        throw new Error(
          `Codec "${entity.codec}" cannot migrate ` +
          `from "${descriptor.codec}"`,
        );
      }

      for (let itemIndex = 0; itemIndex < size; itemIndex++) {
        const sourceValue = sourceCodec.readByOffset(
          offset + itemIndex * descriptor.itemSize,
          view,
        );

        const targetValue = migrate(sourceValue, descriptor.codec);

        targetCodec.writeByItemIndex(itemIndex, chunk.view, targetValue);
      }

      return offset + byteLength;
    };

    const fillMissingEntities = (
      size: number,
      chunks: StorageChunks,
      missingEntities: readonly MissingEntityRestorePlan[],
    ): void => {
      for (const { entity, codec } of missingEntities) {
        const chunk = chunks[entity.kind][entity.name];

        for (let itemIndex = 0; itemIndex < size; itemIndex++) {
          codec.writeByItemIndex(itemIndex, chunk.view, entity.empty);
        }
      }
    };

    const readChunkSet = (
      offset: number,
      view: DataView,
      restorePlan: RestorePlan,
    ): { value: StorageChunkSet; nextOffset: number; } => {
      ensureAvailable(offset, CHUNK_SET_HEADER_SIZE, view, 'Chunk set header');

      const level = view.getUint8(offset);
      offset += UINT8_SIZE;

      const size = view.getUint16(offset, true);
      offset += UINT16_SIZE;

      if (size > STORAGE_CHUNK_CAPACITY) {
        throw new RangeError(
          `Stored chunk set size ${size} exceeds current ` +
          `chunk capacity ${STORAGE_CHUNK_CAPACITY}`,
        );
      }

      const startedAt = view.getFloat64(offset, true);
      offset += FLOAT64_SIZE;

      const endedAt = view.getFloat64(offset, true);
      offset += FLOAT64_SIZE;

      const chunks = createChunks();

      for (const entityPlan of restorePlan.entities) {
        offset = restoreEntity(offset, view, size, chunks, entityPlan);
      }

      fillMissingEntities(size, chunks, restorePlan.missingEntities);

      return {
        value: {
          level,
          start: 0,
          end: size,
          size,
          startedAt,
          endedAt,
          chunks,
        },
        nextOffset: offset,
      };
    };

    return {
      getSize: (
        { chunkSets },
        accumulatorValue,
      ): number => {
        const accumulator = getAccumulator(accumulatorValue);

        const descriptors = getEntityDescriptors(accumulator.entities);

        if (chunkSets.length > 0xffffffff) {
          throw new RangeError(
            `Chunk set count ${chunkSets.length} exceeds uint32 range`,
          );
        }

        let size =
          getEntityDescriptorsSize(descriptors) +
          UINT32_SIZE;

        for (const chunkSet of chunkSets) {
          size += getChunkSetSize(chunkSet, descriptors);
        }

        return size;
      },

      write: (
        offset,
        view,
        { chunkSets },
        accumulatorValue,
      ) => {
        const accumulator = getAccumulator(accumulatorValue);

        const descriptors = getEntityDescriptors(accumulator.entities);

        if (chunkSets.length > 0xffffffff) {
          throw new RangeError(
            `Chunk set count ${chunkSets.length} exceeds uint32 range`,
          );
        }

        offset = writeEntityDescriptors(offset, view, descriptors);

        view.setUint32(offset, chunkSets.length, true);
        offset += UINT32_SIZE;

        for (const chunkSet of chunkSets) {
          offset = writeChunkSet(offset, view, chunkSet, descriptors);
        }

        return {
          value: { chunkSets },
          nextOffset: offset,
        };
      },

      read: (offset, view) => {
        const descriptorResult = readEntityDescriptors(offset, view);

        const descriptors = descriptorResult.value;
        offset = descriptorResult.nextOffset;

        ensureAvailable(offset, UINT32_SIZE, view, 'Chunk set count');

        const chunkSetCount = view.getUint32(offset, true);

        offset += UINT32_SIZE;

        const restorePlan = buildRestorePlan(descriptors);

        const chunkSets: StorageChunkSet[] = [];

        for (let index = 0; index < chunkSetCount; index++) {
          const result = readChunkSet(offset, view, restorePlan);

          chunkSets.push(result.value);
          offset = result.nextOffset;
        }

        return {
          value: { chunkSets },
          nextOffset: offset,
        };
      },
    };
  })(),
);
