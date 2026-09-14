// app/src/shared/utilities/codecs/codecs.ts

import type {
  AnyCodec,
  CodecField,
  CodecFields,
  CodecFieldName,
  CodecFromDefinition,
  FixedCountArrayCodec,
  FixedCountArrayCodecDefinition,
  PrimitiveCodec,
  PrimitiveCodecDefinition,
  SingleObjectCodec,
  SingleObjectCodecDefinition,
  SingleValueCodec,
  SingleValueCodecDefinition,
  VarCountArrayCodec,
  VarCountArrayCodecDefinition,
  AnyCodecDefinition,
  NullableTypedObjectCodecDefinition,
  NullableTypedObjectCodec,
} from '../../types/codecs.js';
import {
  CODEC_DEFINITIONS,
  type CodecAccumulator,
  type CodecData,
  type CodecDefinitions,
  type CodecName,
  type EntityCodecName,
  validEntityCodecDataKinds,
} from './definitions/index.js';

type RuntimeCodecs = {
  [K in CodecName]: CodecFromDefinition<CodecDefinitions[K]>;
};

type MutableCodecs = Record<string, AnyCodec>;

const getBuiltCodec = (
  codecs: MutableCodecs,
  name: string,
): AnyCodec => {
  const codec = codecs[name];

  if (!codec) {
    throw new TypeError(`Codec "${name}" not found`);
  }

  return codec;
};

const getCodecSize = (
  codec: AnyCodec,
  value: unknown,
  accumulator: any,
): number => {
  switch (codec.dataKind) {
    case 'primitive':
    case 'fixedCountArray':
      return codec.size;

    case 'singleValue':
    case 'singleObject':
    case 'nullableTypedObject':
    case 'varCountArray':
      return codec.getSize(value as never, accumulator);
  }
};

const readCodecByOffset = (
  codec: AnyCodec,
  offset: number,
  view: DataView,
  accumulator: any,
): { value: unknown; nextOffset: number } => {
  switch (codec.dataKind) {
    case 'primitive':
    case 'fixedCountArray':
      return {
        value: codec.readByOffset(offset, view, accumulator),
        nextOffset: offset + codec.size,
      };

    case 'singleValue':
    case 'singleObject':
    case 'nullableTypedObject':
    case 'varCountArray':
      return codec.readByOffset(offset, view, accumulator);
  }
};

const writeCodecByOffset = (
  codec: AnyCodec,
  offset: number,
  view: DataView,
  value: unknown,
  accumulator: any,
): { value: unknown; nextOffset: number } => {
  switch (codec.dataKind) {
    case 'primitive':
    case 'fixedCountArray':
      return {
        value: codec.writeByOffset(
          offset,
          view,
          value as never,
          accumulator,
        ),
        nextOffset: offset + codec.size,
      };

    case 'singleValue':
    case 'singleObject':
    case 'nullableTypedObject':
    case 'varCountArray':
      return codec.writeByOffset(
        offset,
        view,
        value as never,
        accumulator,
      );
  }
};

const buildPrimitiveCodec = (
  name: string,
  definition: PrimitiveCodecDefinition<any, any>,
): PrimitiveCodec<any, any> => ({
  name,
  dataKind: 'primitive',
  size: definition.size,
  migrate: definition.migrate,

  readByOffset: (offset, view, accumulator = null) =>
    definition.read(offset, view, accumulator),

  readByItemIndex: (itemIndex, view, accumulator = null) =>
    definition.read(
      itemIndex * definition.size,
      view,
      accumulator,
    ),

  writeByOffset: (offset, view, value, accumulator = null) =>
    definition.write(offset, view, value, accumulator),

  writeByItemIndex: (
    itemIndex,
    view,
    value,
    accumulator = null,
  ) =>
    definition.write(
      itemIndex * definition.size,
      view,
      value,
      accumulator,
    ),
});

const buildSingleValueCodec = (
  name: string,
  definition: SingleValueCodecDefinition<any, any>,
): SingleValueCodec<any, any> => {
  const codec: SingleValueCodec<any, any> = {
    name,
    dataKind: 'singleValue',
    migrate: definition.migrate,

    getSize: (value, accumulator = null) =>
      definition.getSize(value, accumulator),

    readByOffset: (offset, view, accumulator = null) =>
      definition.read(offset, view, accumulator),

    writeByOffset: (
      offset,
      view,
      value,
      accumulator = null,
    ) =>
      definition.write(offset, view, value, accumulator),

    encode(value, accumulator = null) {
      const data = new Uint8Array(
        codec.getSize(value, accumulator),
      );

      const view = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );

      const result =
        codec.writeByOffset(0, view, value, accumulator);

      if (result.nextOffset !== data.byteLength) {
        throw new RangeError(
          `Codec "${name}" wrote ${result.nextOffset} bytes, ` +
          `expected ${data.byteLength}`,
        );
      }

      return data;
    },

    decode(data, accumulator = null) {
      const view = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );

      const result =
        codec.readByOffset(0, view, accumulator);

      if (result.nextOffset !== data.byteLength) {
        throw new RangeError(
          `Codec "${name}" read ${result.nextOffset} bytes, ` +
          `expected ${data.byteLength}`,
        );
      }

      return result.value;
    },
  };

  return codec;
};

const buildNullableTypedObjectCodec = (
  name: string,
  definition: NullableTypedObjectCodecDefinition<any>,
): NullableTypedObjectCodec<any> => {
  const codec: NullableTypedObjectCodec<any> = {
    name,
    dataKind: 'nullableTypedObject',
    migrate: definition.migrate,

    getSize: (value, accumulator = null) =>
      definition.getSize(value, accumulator),

    readByOffset: (offset, view, accumulator = null) =>
      definition.read(offset, view, accumulator),

    writeByOffset: (
      offset,
      view,
      value,
      accumulator = null,
    ) =>
      definition.write(offset, view, value, accumulator),

    encode(value, accumulator = null) {
      const data = new Uint8Array(
        codec.getSize(value, accumulator),
      );

      const view = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );

      const result = codec.writeByOffset(
        0,
        view,
        value,
        accumulator,
      );

      if (result.nextOffset !== data.byteLength) {
        throw new RangeError(
          `Codec "${name}" wrote ${result.nextOffset} bytes, ` +
          `expected ${data.byteLength}`,
        );
      }

      return data;
    },

    decode(data, accumulator = null) {
      const view = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );

      const result = codec.readByOffset(
        0,
        view,
        accumulator,
      );

      if (result.nextOffset !== data.byteLength) {
        throw new RangeError(
          `Codec "${name}" read ${result.nextOffset} bytes, ` +
          `expected ${data.byteLength}`,
        );
      }

      return result.value;
    },
  };

  return codec;
};

const validateObjectFields = <T extends object>(
  name: string,
  fieldNames: readonly CodecFieldName<T>[],
  value: T,
): void => {
  const actual = Object.keys(value).sort();

  if (
    actual.length === fieldNames.length &&
    actual.every(
      (fieldName, index) =>
        fieldName === fieldNames[index],
    )
  ) {
    return;
  }

  throw new TypeError(
    `Invalid fields for codec "${name}": expected ` +
    `[${fieldNames.join(', ')}], got [${actual.join(', ')}]`,
  );
};

const buildFixedCountArrayCodec = <
  T extends object,
  A = null,
>(
  codecs: MutableCodecs,
  name: string,
  definition: FixedCountArrayCodecDefinition<T, A>,
): FixedCountArrayCodec<T, A> => {
  type FieldName = CodecFieldName<T>;

  let fields: CodecFields<T, A> | null = null;
  let fieldNames: readonly FieldName[] | null = null;
  let size: number | null = null;
  let resolving = false;

  const initializeFields = (): void => {
    if (fields) {
      return;
    }

    if (resolving) {
      throw new Error(
        `Circular codec dependency involving "${name}"`,
      );
    }

    resolving = true;

    try {
      const names: FieldName[] = [];
      const result: Partial<CodecFields<T, A>> = {};
      let currentOffset = 0;

      for (const fieldDefinition of definition.fieldSet) {
        const fieldName = fieldDefinition.fieldName;

        if (fieldName in result) {
          throw new Error(
            `Duplicate field "${fieldName}" in codec "${name}"`,
          );
        }

        const fieldCodec = getBuiltCodec(codecs, fieldDefinition.codec);

        if (
          fieldCodec.dataKind !== 'primitive' &&
          fieldCodec.dataKind !== 'fixedCountArray'
        ) {
          throw new TypeError(
            `Codec "${fieldDefinition.codec}" cannot be used ` +
            `as field "${fieldName}" of codec "${name}"`,
          );
        }

        const fieldOffset = currentOffset;

        (
          result as Record<string, CodecField<T, A>>
        )[fieldName] = {
          fieldName,
          offset: fieldOffset,
          size: fieldCodec.size,

          readByOffset: (offset, view, accumulator) =>
            fieldCodec.readByOffset(
              offset + fieldOffset,
              view,
              accumulator,
            ),

          readByItemIndex: (
            itemIndex,
            view,
            accumulator,
          ) =>
            fieldCodec.readByOffset(
              itemIndex * fixedCountArrayCodec.size +
                fieldOffset,
              view,
              accumulator,
            ),

          writeByOffset: (
            offset,
            view,
            value,
            accumulator,
          ) =>
            fieldCodec.writeByOffset(
              offset + fieldOffset,
              view,
              value,
              accumulator,
            ),

          writeByItemIndex: (
            itemIndex,
            view,
            value,
            accumulator,
          ) =>
            fieldCodec.writeByOffset(
              itemIndex * fixedCountArrayCodec.size +
                fieldOffset,
              view,
              value,
              accumulator,
            ),
        };

        names.push(fieldName);
        currentOffset += fieldCodec.size;
      }

      fields = result as CodecFields<T, A>;
      fieldNames = names.sort();
      size = currentOffset;
    } finally {
      resolving = false;
    }
  };

  const fixedCountArrayCodec: FixedCountArrayCodec<T, A> = {
    name,
    dataKind: 'fixedCountArray',
    migrate: definition.migrate,

    get size() {
      initializeFields();
      return size!;
    },

    get fieldNames() {
      initializeFields();
      return fieldNames!;
    },

    get fields() {
      initializeFields();
      return fields!;
    },

    readByOffset(offset, view, accumulator = null as A) {
      const result = {} as T;

      for (const fieldName of fixedCountArrayCodec.fieldNames) {
        result[fieldName] =
          fixedCountArrayCodec.fields[fieldName].readByOffset(
            offset,
            view,
            accumulator,
          ) as T[typeof fieldName];
      }

      return result;
    },

    readByItemIndex(
      itemIndex,
      view,
      accumulator = null as A,
    ) {
      return fixedCountArrayCodec.readByOffset(
        itemIndex * fixedCountArrayCodec.size,
        view,
        accumulator,
      );
    },

    writeByOffset(
      offset,
      view,
      value,
      accumulator = null as A,
    ) {
      validateObjectFields(
        name,
        fixedCountArrayCodec.fieldNames,
        value,
      );

      const result = {} as T;

      for (const fieldName of fixedCountArrayCodec.fieldNames) {
        result[fieldName] =
          fixedCountArrayCodec.fields[fieldName].writeByOffset(
            offset,
            view,
            value[fieldName],
            accumulator,
          ) as T[typeof fieldName];
      }

      return result;
    },

    writeByItemIndex(
      itemIndex,
      view,
      value,
      accumulator = null as A,
    ) {
      return fixedCountArrayCodec.writeByOffset(
        itemIndex * fixedCountArrayCodec.size,
        view,
        value,
        accumulator,
      );
    },
  };

  return fixedCountArrayCodec;
};

const buildCodecs = (): RuntimeCodecs => {
  const codecs: MutableCodecs = {};

  for (const [name, concreteDefinition] of Object.entries(
    CODEC_DEFINITIONS,
  )) {
    const definition =
      concreteDefinition as AnyCodecDefinition;

    if (name in codecs) {
      throw new Error(`Duplicate codec "${name}"`);
    }

    switch (definition.dataKind) {
      case 'primitive':
        codecs[name] = buildPrimitiveCodec(
          name,
          definition,
        );
        break;

      case 'fixedCountArray':
        codecs[name] = buildFixedCountArrayCodec(
          codecs,
          name,
          definition,
        );
        break;

      case 'singleValue':
        codecs[name] = buildSingleValueCodec(
          name,
          definition,
        );
        break;

      case 'singleObject':
        codecs[name] = buildSingleObjectCodec(
          codecs,
          name,
          definition,
        );
        break;

      case 'nullableTypedObject':
        codecs[name] = buildNullableTypedObjectCodec(
          name,
          definition as NullableTypedObjectCodecDefinition<any>,
        );
        break;

      case 'varCountArray':
        codecs[name] = buildVarCountArrayCodec(
          codecs,
          name,
          definition,
        );
        break;
    }
  }

  return codecs as RuntimeCodecs;
};

const buildSingleObjectCodec = <
  T extends object,
  A = null,
>(
  codecs: MutableCodecs,
  name: string,
  definition: SingleObjectCodecDefinition<T, A>,
): SingleObjectCodec<T, A> => {
  type FieldName = CodecFieldName<T>;

  let fieldNames: readonly FieldName[] | null = null;
  let resolving = false;

  const initialize = (): void => {
    if (fieldNames) {
      return;
    }

    if (resolving) {
      throw new Error(
        `Circular codec dependency involving "${name}"`,
      );
    }

    resolving = true;

    try {
      const names = new Set<FieldName>();

      for (const field of definition.fieldSet) {
        if (names.has(field.fieldName)) {
          throw new Error(
            `Duplicate field "${field.fieldName}" ` +
            `in codec "${name}"`,
          );
        }

        getBuiltCodec(codecs, field.codec);
        names.add(field.fieldName);
      }

      fieldNames = [...names].sort();
    } finally {
      resolving = false;
    }
  };

  const codec: SingleObjectCodec<T, A> = {
    name,
    dataKind: 'singleObject',
    migrate: definition.migrate,

    get fieldNames() {
      initialize();
      return fieldNames!;
    },

    getSize(value, accumulator = null as A) {
      validateObjectFields(
        name,
        codec.fieldNames,
        value,
      );

      let size = 0;

      for (const field of definition.fieldSet) {
        const fieldCodec =
          getBuiltCodec(codecs, field.codec);

        size += getCodecSize(
          fieldCodec,
          value[field.fieldName],
          accumulator,
        );
      }

      return size;
    },

    readByOffset(offset, view, accumulator = null as A) {
      initialize();

      const result = {} as T;
      let nextOffset = offset;

      for (const field of definition.fieldSet) {
        const fieldCodec =
          getBuiltCodec(codecs, field.codec);

        const fieldResult = readCodecByOffset(
          fieldCodec,
          nextOffset,
          view,
          accumulator,
        );

        result[field.fieldName] =
          fieldResult.value as T[typeof field.fieldName];

        nextOffset = fieldResult.nextOffset;
      }

      return {
        value: result,
        nextOffset,
      };
    },

    writeByOffset(
      offset,
      view,
      value,
      accumulator = null as A,
    ) {
      validateObjectFields(
        name,
        codec.fieldNames,
        value,
      );

      const result = {} as T;
      let nextOffset = offset;

      for (const field of definition.fieldSet) {
        const fieldCodec =
          getBuiltCodec(codecs, field.codec);

        const fieldResult = writeCodecByOffset(
          fieldCodec,
          nextOffset,
          view,
          value[field.fieldName],
          accumulator,
        );

        result[field.fieldName] =
          fieldResult.value as T[typeof field.fieldName];

        nextOffset = fieldResult.nextOffset;
      }

      return {
        value: result,
        nextOffset,
      };
    },

    encode(value, accumulator = null as A) {
      const data =
        new Uint8Array(codec.getSize(value, accumulator));

      const view = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );

      const result =
        codec.writeByOffset(0, view, value, accumulator);

      if (result.nextOffset !== data.byteLength) {
        throw new RangeError(
          `Codec "${name}" wrote ${result.nextOffset} bytes, ` +
          `expected ${data.byteLength}`,
        );
      }

      return data;
    },

    decode(data, accumulator = null as A) {
      const view = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );

      const result =
        codec.readByOffset(0, view, accumulator);

      if (result.nextOffset !== data.byteLength) {
        throw new RangeError(
          `Codec "${name}" read ${result.nextOffset} bytes, ` +
          `expected ${data.byteLength}`,
        );
      }

      return result.value;
    },
  };

  return codec;
};

const buildVarCountArrayCodec = <T, A = null>(
  codecs: MutableCodecs,
  name: string,
  definition: VarCountArrayCodecDefinition<T, A>,
): VarCountArrayCodec<T, A> => {
  const getDependencies = () => {
    const countCodec =
      getBuiltCodec(codecs, definition.countCodec);

    const itemCodec =
      getBuiltCodec(codecs, definition.itemCodec);

    if (countCodec.dataKind !== 'primitive') {
      throw new TypeError(
        `Count codec "${definition.countCodec}" of codec ` +
        `"${name}" must be primitive`,
      );
    }

    return {
      countCodec,
      itemCodec,
    };
  };

  const codec: VarCountArrayCodec<T, A> = {
    name,
    dataKind: 'varCountArray',
    migrate: definition.migrate,

    getSize(value, accumulator = null as A) {
      const { countCodec, itemCodec } =
        getDependencies();

      let size = countCodec.size;

      for (const item of value) {
        size += getCodecSize(
          itemCodec,
          item,
          accumulator,
        );
      }

      return size;
    },

    readByOffset(offset, view, accumulator = null as A) {
      const { countCodec, itemCodec } =
        getDependencies();

      const count = countCodec.readByOffset(
        offset,
        view,
        accumulator,
      );

      if (
        typeof count !== 'number' ||
        !Number.isInteger(count) ||
        count < 0
      ) {
        throw new TypeError(
          `Codec "${definition.countCodec}" returned ` +
          `invalid item count ${String(count)}`,
        );
      }

      let nextOffset = offset + countCodec.size;
      const value: T[] = [];

      for (let index = 0; index < count; index++) {
        const result = readCodecByOffset(
          itemCodec,
          nextOffset,
          view,
          accumulator,
        );

        value.push(result.value as T);
        nextOffset = result.nextOffset;
      }

      return {
        value,
        nextOffset,
      };
    },

    writeByOffset(
      offset,
      view,
      value,
      accumulator = null as A,
    ) {
      const { countCodec, itemCodec } =
        getDependencies();

      const writtenCount = countCodec.writeByOffset(
        offset,
        view,
        value.length,
        accumulator,
      );

      if (writtenCount !== value.length) {
        throw new RangeError(
          `Codec "${definition.countCodec}" cannot encode ` +
          `item count ${value.length} without changing it`,
        );
      }

      let nextOffset = offset + countCodec.size;
      const result: T[] = [];

      for (const item of value) {
        const itemResult = writeCodecByOffset(
          itemCodec,
          nextOffset,
          view,
          item,
          accumulator,
        );

        result.push(itemResult.value as T);
        nextOffset = itemResult.nextOffset;
      }

      return {
        value: result,
        nextOffset,
      };
    },

    encode(value, accumulator = null as A) {
      const data =
        new Uint8Array(codec.getSize(value, accumulator));

      const view = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );

      const result =
        codec.writeByOffset(0, view, value, accumulator);

      if (result.nextOffset !== data.byteLength) {
        throw new RangeError(
          `Codec "${name}" wrote ${result.nextOffset} bytes, ` +
          `expected ${data.byteLength}`,
        );
      }

      return data;
    },

    decode(data, accumulator = null as A) {
      const view = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );

      const result =
        codec.readByOffset(0, view, accumulator);

      if (result.nextOffset !== data.byteLength) {
        throw new RangeError(
          `Codec "${name}" read ${result.nextOffset} bytes, ` +
          `expected ${data.byteLength}`,
        );
      }

      return result.value;
    },
  };

  return codec;
};

const CODECS = buildCodecs();

export const getCodec = (
  name: string,
): AnyCodec => {
  const codec =
    (CODECS as Record<string, AnyCodec>)[name];

  if (!codec) {
    throw new TypeError(`Codec "${name}" not found`);
  }

  return codec;
};

export const isCodecName = (
  name: string,
): name is CodecName => name in CODECS;

export const getCodecEncodedSize = <N extends CodecName>(
  name: N,
  value: CodecData<N>,
  accumulator?: CodecAccumulator<N>,
): number =>
  getCodecSize(
    CODECS[name],
    value,
    accumulator,
  );

export const writeCodec = <N extends CodecName>(
  name: N,
  offset: number,
  view: DataView,
  value: CodecData<N>,
  accumulator?: CodecAccumulator<N>,
): number =>
  writeCodecByOffset(
    CODECS[name],
    offset,
    view,
    value,
    accumulator,
  ).nextOffset;

export const readCodec = <N extends CodecName>(
  name: N,
  offset: number,
  view: DataView,
  accumulator?: CodecAccumulator<N>,
): {
  value: CodecData<N>;
  nextOffset: number;
} => {
  const result = readCodecByOffset(
    CODECS[name],
    offset,
    view,
    accumulator,
  );

  return {
    value: result.value as CodecData<N>,
    nextOffset: result.nextOffset,
  };
};

export const binaryCodec = <N extends CodecName>(
  name: N,
): RuntimeCodecs[N] => {
  const codec = CODECS[name];

  if (!codec) {
    throw new TypeError(`Codec ${name} not found`);
  }

  return codec;
};

export const entityBinaryCodec = <N extends EntityCodecName>(
  name: N,
): RuntimeCodecs[N] => {
  const codec = CODECS[name];

  if (!codec) {
    throw new TypeError(`Codec ${name} not found`);
  }

  if (!validEntityCodecDataKinds.includes(codec.dataKind)) {
    throw new TypeError(
      `Entity Codec must have one of folloving dataKind types: ` +
      `${validEntityCodecDataKinds.join(', ')}`
    );
  }

  return codec;
};

export const encodeCodec = <N extends CodecName>(
  name: N,
  value: CodecData<N>,
  accumulator?: CodecAccumulator<N>,
): Uint8Array => {
  const codec = CODECS[name];

  if (!('encode' in codec)) {
    throw new TypeError(
      `Codec "${name}" does not support standalone encoding`,
    );
  }

  return codec.encode(value as never, accumulator as never);
};

export const decodeCodec = <N extends CodecName>(
  name: N,
  data: Uint8Array,
  accumulator?: CodecAccumulator<N>,
): CodecData<N> => {
  const codec = CODECS[name];

  if (!('decode' in codec)) {
    throw new TypeError(
      `Codec "${name}" does not support standalone decoding`,
    );
  }

  return codec.decode(
    data,
    accumulator as never,
  ) as CodecData<N>;
};
