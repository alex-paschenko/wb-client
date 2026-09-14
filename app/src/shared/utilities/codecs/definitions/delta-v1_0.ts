// app/src/shared/utilities/codecs/definitions/delta-v1_0.ts

import { globalStateService } from '../../../services/global-state.js';
import type {
  FixedSizeCodec,
  SingleValueCodec,
} from '../../../types/codecs.js';
import type {
  StorageDeltaCodecAccumulator,
  StorageDeltaCodecData,
  StorageDeltaEntityChanges,
  StorageDeltaParams,
  StorageStructuralChange,
} from '../../../types/storage-delta.js';
import { getCodec } from '../codecs.js';
import { singleValueCodecDefinition } from './codec-definition-helpers.js';
import { FLOAT64_SIZE, UINT16_SIZE, UINT8_SIZE } from './general-constants.js';

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

const OPERATION_TYPES = {
  addItem: 1,
  deleteItems: 2,
} as const;

const ADD_ITEM_SIZE =
  UINT8_SIZE +
  UINT8_SIZE +
  FLOAT64_SIZE * 2;

const DELETE_ITEMS_SIZE =
  UINT8_SIZE +
  UINT8_SIZE +
  UINT16_SIZE +
  FLOAT64_SIZE;

const DELTA_PARAMS_SIZE =
  UINT16_SIZE +
  FLOAT64_SIZE * 2;

const INTERVAL_HEADER_SIZE = UINT8_SIZE * 3;

const getSingleValueCodec = (
  name: string,
): SingleValueCodec<any, any> => {
  const codec = getCodec(name);

  if (codec.dataKind !== 'singleValue') {
    throw new TypeError(
      `Codec "${name}" must be singleValue`,
    );
  }

  return codec;
};

const getFixedSizeCodec = (
  name: string,
): FixedSizeCodec => {
  const codec = getCodec(name);

  if (
    codec.dataKind !== 'primitive' &&
    codec.dataKind !== 'fixedCountArray'
  ) {
    throw new TypeError(
      `Codec "${name}" must be fixed-size`,
    );
  }

  return codec;
};

const getAccumulator = (
  accumulator: StorageDeltaCodecAccumulator | null,
): StorageDeltaCodecAccumulator => {
  if (!accumulator) {
    throw new Error(
      'Storage delta codec requires an accumulator',
    );
  }

  return accumulator;
};

const paramsEqual = (
  first: StorageDeltaParams,
  second: StorageDeltaParams,
): boolean =>
  first.size === second.size &&
  Object.is(first.startedAt, second.startedAt) &&
  Object.is(first.endedAt, second.endedAt);

const paramsToString = (
  params: StorageDeltaParams,
): string =>
  `size=${params.size}, startedAt=${params.startedAt}, ` +
  `endedAt=${params.endedAt}`;

const validateCurrentParams = (
  expected: StorageDeltaParams,
  accumulator: StorageDeltaCodecAccumulator,
  stage: 'start' | 'end',
): void => {
  const actual = accumulator.getCurrentParams();

  if (paramsEqual(actual, expected)) {
    return;
  }

  throw new Error(
    `Storage delta ${stage} params mismatch: expected ` +
    `${paramsToString(expected)}, got ${paramsToString(actual)}`,
  );
};

const getStructuralChangesSize = (
  changes: readonly StorageStructuralChange[],
): number => {
  if (changes.length > 0xffff) {
    throw new RangeError(
      `Storage structural change count ${changes.length} ` +
      `exceeds uint16 range`,
    );
  }

  let size = UINT16_SIZE;

  for (const change of changes) {
    size += change.type === 'addItem'
      ? ADD_ITEM_SIZE
      : DELETE_ITEMS_SIZE;
  }

  return size;
};

const getEntityChangesSize = (
  entityChanges: readonly StorageDeltaEntityChanges[],
): number => {
  if (entityChanges.length > 0xffff) {
    throw new RangeError(
      `Storage changed entity count ${entityChanges.length} ` +
      `exceeds uint16 range`,
    );
  }

  const entities = globalStateService.getStorageEntities();

  let size = UINT16_SIZE;

  for (const entityChange of entityChanges) {
    const entity = entities[entityChange.entityIndex];

    if (
      !entity ||
      entity.kind !== entityChange.entityKind ||
      entity.name !== entityChange.entityName
    ) {
      throw new Error(
        `Invalid storage entity index ` +
        `${entityChange.entityIndex} for ` +
        `"${entityChange.entityKind}:${entityChange.entityName}"`,
      );
    }

    if (entityChange.entityIndex > 0xffff) {
      throw new RangeError(
        `Storage entity index ${entityChange.entityIndex} ` +
        `exceeds uint16 range`,
      );
    }

    if (entityChange.changes.length > 0xffff) {
      throw new RangeError(
        `Storage interval count ` +
        `${entityChange.changes.length} for ` +
        `"${entity.kind}:${entity.name}" exceeds uint16 range`,
      );
    }

    const codec = getFixedSizeCodec(entity.codec);

    size += UINT16_SIZE * 2;

    for (const interval of entityChange.changes) {
      size +=
        INTERVAL_HEADER_SIZE +
        interval.itemsCount * codec.size;
    }
  }

  return size;
};

const writeParams = (
  offset: number,
  view: DataView,
  params: StorageDeltaParams,
): number => {
  const nullableFloat64 =
    getSingleValueCodec('float64 (nullable) v1.0');

  view.setUint16(offset, params.size, true);
  offset += UINT16_SIZE;

  offset = nullableFloat64.writeByOffset(
    offset,
    view,
    params.startedAt,
  ).nextOffset;

  offset = nullableFloat64.writeByOffset(
    offset,
    view,
    params.endedAt,
  ).nextOffset;

  return offset;
};

const readParams = (
  offset: number,
  view: DataView,
): {
  value: StorageDeltaParams;
  nextOffset: number;
} => {
  const nullableFloat64 =
    getSingleValueCodec('float64 (nullable) v1.0');

  const size = view.getUint16(offset, true);
  offset += UINT16_SIZE;

  const startedAtResult =
    nullableFloat64.readByOffset(offset, view);

  offset = startedAtResult.nextOffset;

  const endedAtResult =
    nullableFloat64.readByOffset(offset, view);

  offset = endedAtResult.nextOffset;

  return {
    value: {
      size,
      startedAt: startedAtResult.value,
      endedAt: endedAtResult.value,
    },
    nextOffset: offset,
  };
};

const writeStructuralChanges = (
  offset: number,
  view: DataView,
  changes: readonly StorageStructuralChange[],
): number => {
  view.setUint16(offset, changes.length, true);
  offset += UINT16_SIZE;

  const nullableFloat64 = getSingleValueCodec('float64 (nullable) v1.0');

  for (const change of changes) {
    view.setUint8(
      offset,
      OPERATION_TYPES[change.type],
    );

    offset += UINT8_SIZE;

    view.setUint8(offset, change.level);
    offset += UINT8_SIZE;

    if (change.type === 'addItem') {
      view.setFloat64(
        offset,
        change.startedAt,
        true,
      );

      offset += FLOAT64_SIZE;

      view.setFloat64(
        offset,
        change.endedAt,
        true,
      );

      offset += FLOAT64_SIZE;

      continue;
    }

    view.setUint16(offset, change.count, true);
    offset += UINT16_SIZE;

    offset = nullableFloat64.writeByOffset(
      offset,
      view,
      change.newStartedAt,
    ).nextOffset;
  }

  return offset;
};

const readStructuralChanges = (
  offset: number,
  view: DataView,
): {
  value: StorageStructuralChange[];
  nextOffset: number;
} => {
  const changesCount = view.getUint16(offset, true);
  offset += UINT16_SIZE;

  const nullableFloat64 = getSingleValueCodec('float64 (nullable) v1.0');

  const changes: StorageStructuralChange[] = [];

  for (let index = 0; index < changesCount; index++) {
    const operationType = view.getUint8(offset);
    offset += UINT8_SIZE;

    const level = view.getUint8(offset);
    offset += UINT8_SIZE;

    if (operationType === OPERATION_TYPES.addItem) {
      const startedAt =
        view.getFloat64(offset, true);

      offset += FLOAT64_SIZE;

      const endedAt =
        view.getFloat64(offset, true);

      offset += FLOAT64_SIZE;

      changes.push({
        type: 'addItem',
        level,
        startedAt,
        endedAt,
      });

      continue;
    }

    if (operationType === OPERATION_TYPES.deleteItems) {
      const count = view.getUint16(offset, true);

      offset += UINT16_SIZE;

      const newStartedAtResult =
        nullableFloat64.readByOffset(offset, view);

      offset = newStartedAtResult.nextOffset;

      changes.push({
        type: 'deleteItems',
        level,
        count,
        newStartedAt: newStartedAtResult.value,
      });

      continue;
    }

    throw new TypeError(
      `Unknown storage delta operation type ${operationType}`,
    );
  }

  return {
    value: changes,
    nextOffset: offset,
  };
};

const writeEntityChanges = (
  offset: number,
  view: DataView,
  entityChanges: readonly StorageDeltaEntityChanges[],
  accumulator: StorageDeltaCodecAccumulator,
): number => {
  view.setUint16(offset, entityChanges.length, true);
  offset += UINT16_SIZE;

  const entities =
    globalStateService.getStorageEntities();

  const chunkSets = accumulator.getChunkSets();

  for (const entityChange of entityChanges) {
    const entity = entities[entityChange.entityIndex]!;
    const codec = getFixedSizeCodec(entity.codec);

    view.setUint16(
      offset,
      entityChange.entityIndex,
      true,
    );

    offset += UINT16_SIZE;

    view.setUint16(
      offset,
      entityChange.changes.length,
      true,
    );

    offset += UINT16_SIZE;

    for (const interval of entityChange.changes) {
      view.setUint8(
        offset,
        interval.chunkSetIndex,
      );

      offset += UINT8_SIZE;

      view.setUint8(
        offset,
        interval.startItemIndex,
      );

      offset += UINT8_SIZE;

      view.setUint8(
        offset,
        interval.itemsCount,
      );

      offset += UINT8_SIZE;

      const chunkSet =
        chunkSets[interval.chunkSetIndex]!;

      const chunk =
        chunkSet.chunks[entity.kind][entity.name];

      const startByte =
        interval.startItemIndex * codec.size;

      const byteLength =
        interval.itemsCount * codec.size;

      new Uint8Array(
        view.buffer,
        view.byteOffset + offset,
        byteLength,
      ).set(
        chunk.data.subarray(
          startByte,
          startByte + byteLength,
        ),
      );

      offset += byteLength;
    }
  }

  return offset;
};

const readEntityChanges = (
  offset: number,
  view: DataView,
  accumulator: StorageDeltaCodecAccumulator,
): {
  value: StorageDeltaEntityChanges[];
  nextOffset: number;
} => {
  const changedEntityCount =
    view.getUint16(offset, true);

  offset += UINT16_SIZE;

  const entities =
    globalStateService.getStorageEntities();

  const chunkSets = accumulator.getChunkSets();

  const entityChanges: StorageDeltaEntityChanges[] = [];

  for (
    let entityChangeIndex = 0;
    entityChangeIndex < changedEntityCount;
    entityChangeIndex++
  ) {
    const entityIndex =
      view.getUint16(offset, true);

    offset += UINT16_SIZE;

    const entity = entities[entityIndex];

    if (!entity) {
      throw new RangeError(
        `Unknown storage entity index ${entityIndex}`,
      );
    }

    const intervalCount =
      view.getUint16(offset, true);

    offset += UINT16_SIZE;

    const codec = getFixedSizeCodec(entity.codec);

    const changes =
      [] as StorageDeltaEntityChanges['changes'];

    for (
      let intervalIndex = 0;
      intervalIndex < intervalCount;
      intervalIndex++
    ) {
      const chunkSetIndex =
        view.getUint8(offset);

      offset += UINT8_SIZE;

      const startItemIndex =
        view.getUint8(offset);

      offset += UINT8_SIZE;

      const itemsCount =
        view.getUint8(offset);

      offset += UINT8_SIZE;

      const chunkSet =
        chunkSets[chunkSetIndex];

      if (!chunkSet) {
        throw new RangeError(
          `Storage chunk set index ${chunkSetIndex} ` +
          `is out of range`,
        );
      }

      if (
        itemsCount === 0 ||
        startItemIndex < chunkSet.start ||
        startItemIndex + itemsCount > chunkSet.end
      ) {
        throw new RangeError(
          `Invalid storage delta interval in chunk set ` +
          `${chunkSetIndex}: start=${startItemIndex}, ` +
          `count=${itemsCount}, ` +
          `live=${chunkSet.start}..${chunkSet.end}`,
        );
      }

      const chunk =
        chunkSet.chunks[entity.kind]?.[entity.name];

      if (!chunk) {
        throw new Error(
          `Storage chunk ` +
          `"${entity.kind}:${entity.name}" not found in ` +
          `chunk set ${chunkSetIndex}`,
        );
      }

      const startByte =
        startItemIndex * codec.size;

      const byteLength =
        itemsCount * codec.size;

      const nextOffset = offset + byteLength;

      if (nextOffset > view.byteLength) {
        throw new RangeError(
          'Storage delta entity data exceeds binary size',
        );
      }

      chunk.data.set(
        new Uint8Array(
          view.buffer,
          view.byteOffset + offset,
          byteLength,
        ),
        startByte,
      );

      changes.push({
        chunkSetIndex,
        startItemIndex,
        itemsCount,
      });

      offset = nextOffset;
    }

    entityChanges.push({
      entityKind: entity.kind,
      entityName: entity.name,
      entityIndex,
      changes,
    });
  }

  return {
    value: entityChanges,
    nextOffset: offset,
  };
};

export const delta_V1_0 = singleValueCodecDefinition<
  StorageDeltaCodecData,
  StorageDeltaCodecAccumulator
>({
  getSize: (value, accumulator) => {
    getAccumulator(accumulator);

    return UINT8_SIZE +
      DELTA_PARAMS_SIZE * 2 +
      getStructuralChangesSize(value.structuralChanges) +
      getEntityChangesSize(value.entityChanges);
  },

  write: (
    offset,
    view,
    value,
    accumulatorValue,
  ) => {
    const accumulator = getAccumulator(accumulatorValue);

    view.setUint8(offset, value.flags);
    offset += UINT8_SIZE;

    offset = writeParams(
      offset,
      view,
      value.startParams,
    );

    offset = writeParams(
      offset,
      view,
      value.endParams,
    );

    offset = writeStructuralChanges(
      offset,
      view,
      value.structuralChanges,
    );

    offset = writeEntityChanges(
      offset,
      view,
      value.entityChanges,
      accumulator,
    );

    return {
      value,
      nextOffset: offset,
    };
  },

  read: (
    offset,
    view,
    accumulatorValue,
  ) => {
    const accumulator = getAccumulator(accumulatorValue);

    const flags = view.getUint8(offset);
    offset += UINT8_SIZE;

    const startParamsResult = readParams(offset, view);

    const startParams = startParamsResult.value;
    offset = startParamsResult.nextOffset;

    const endParamsResult = readParams(offset, view);

    const endParams = endParamsResult.value;
    offset = endParamsResult.nextOffset;

    validateCurrentParams(startParams, accumulator, 'start');

    const structuralResult = readStructuralChanges(offset, view);

    const structuralChanges = structuralResult.value;

    offset = structuralResult.nextOffset;

    accumulator.applyStructuralChanges(structuralChanges);

    validateCurrentParams(endParams, accumulator, 'end');

    const entityChangesResult =
      readEntityChanges(offset, view, accumulator);

    return {
      value: {
        flags,
        startParams,
        endParams,
        structuralChanges,
        entityChanges: entityChangesResult.value,
      },
      nextOffset: entityChangesResult.nextOffset,
    };
  },
});
