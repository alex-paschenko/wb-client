// app/src/shared/utilities/codecs/definitions/
// nullable-typed-object-v1_0.ts

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

import type {
  NullableTypedObjectValue,
  SingleValueCodec,
} from '../../../types/codecs.js';
import { getCodec } from '../codecs.js';
import {
  nullableTypedObjectCodecDefinition,
} from './codec-definition-helpers.js';
import {
  UINT16_SIZE,
  UINT8_SIZE,
} from './general-constants.js';

const NULL_FIELD_COUNT = 0xffff;

const valueTypes = [
  'string',
] as const;

type ValueType = typeof valueTypes[number];

const typedCodecs = {
  string: 'string (2^16) v1.0',
} as const satisfies Record<ValueType, string>;

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

const getValueType = (
  fieldName: string,
  value: unknown,
): ValueType => {
  const valueType = typeof value;
  const valueTypeIndex =
    valueTypes.indexOf(valueType as ValueType);

  if (valueTypeIndex < 0) {
    throw new TypeError(
      `Unsupported value type "${valueType}" ` +
      `for field "${fieldName}"`,
    );
  }

  return valueTypes[valueTypeIndex];
};

export const nullableTypedObject_V1_0 = nullableTypedObjectCodecDefinition({
  getSize: (value: NullableTypedObjectValue): number => {
    if (value === null) {
      return UINT16_SIZE;
    }

    const entries = Object.entries(value);

    if (entries.length >= NULL_FIELD_COUNT) {
      throw new RangeError(
        `Too many typed object fields: ${entries.length}`,
      );
    }

    const stringCodec =
      getSingleValueCodec('string (2^16) v1.0');

    let size = UINT16_SIZE;

    for (const [fieldName, fieldValue] of entries) {
      const valueType = getValueType(fieldName, fieldValue);
      const valueCodec =
        getSingleValueCodec(typedCodecs[valueType]);

      size += stringCodec.getSize(fieldName);
      size += UINT8_SIZE;
      size += valueCodec.getSize(fieldValue);
    }

    return size;
  },

  write: (
    offset,
    view,
    value: NullableTypedObjectValue,
  ) => {
    if (value === null) {
      view.setUint16(offset, NULL_FIELD_COUNT, true);

      return {
        value,
        nextOffset: offset + UINT16_SIZE,
      };
    }

    const entries = Object.entries(value);

    if (entries.length >= NULL_FIELD_COUNT) {
      throw new RangeError(
        `Too many typed object fields: ${entries.length}`,
      );
    }

    const stringCodec =
      getSingleValueCodec('string (2^16) v1.0');

    view.setUint16(offset, entries.length, true);
    offset += UINT16_SIZE;

    for (const [fieldName, fieldValue] of entries) {
      const valueType = getValueType(fieldName, fieldValue);
      const valueTypeIndex = valueTypes.indexOf(valueType);

      offset = stringCodec.writeByOffset(
        offset,
        view,
        fieldName,
      ).nextOffset;

      view.setUint8(offset, valueTypeIndex);
      offset += UINT8_SIZE;

      const valueCodec =
        getSingleValueCodec(typedCodecs[valueType]);

      offset = valueCodec.writeByOffset(
        offset,
        view,
        fieldValue,
      ).nextOffset;
    }

    return {
      value,
      nextOffset: offset,
    };
  },

  read: (
    offset,
    view,
  ) => {
    const fieldCount = view.getUint16(offset, true);
    offset += UINT16_SIZE;

    if (fieldCount === NULL_FIELD_COUNT) {
      return {
        value: null,
        nextOffset: offset,
      };
    }

    const stringCodec =
      getSingleValueCodec('string (2^16) v1.0');

    const value: Record<string, unknown> = {};

    for (let index = 0; index < fieldCount; index++) {
      const fieldNameResult =
        stringCodec.readByOffset(offset, view);

      const fieldName = fieldNameResult.value;
      offset = fieldNameResult.nextOffset;

      const valueTypeIndex = view.getUint8(offset);
      offset += UINT8_SIZE;

      const valueType = valueTypes[valueTypeIndex];

      if (!valueType) {
        throw new TypeError(
          `Unknown typed object value type ` +
          `${valueTypeIndex}`,
        );
      }

      const valueCodec =
        getSingleValueCodec(typedCodecs[valueType]);

      const valueResult =
        valueCodec.readByOffset(offset, view);

      value[fieldName] = valueResult.value;
      offset = valueResult.nextOffset;
    }

    return {
      value,
      nextOffset: offset,
    };
  },
});
