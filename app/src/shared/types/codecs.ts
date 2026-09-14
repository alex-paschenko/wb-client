// app/src/shared/types/codecs.ts

export type CodecFieldName<T extends object> =
  Extract<keyof T, string>;

export type CodecDataKind =
  | 'primitive'
  | 'fixedCountArray'
  | 'singleValue'
  | 'singleObject'
  | 'nullableTypedObject'
  | 'varCountArray';

export interface CodecReadResult<T> {
  value: T;
  nextOffset: number;
}

export interface CodecWriteResult<T> {
  value: T;
  nextOffset: number;
}

export type ReadDefinition<T, A = null> = (
  offset: number,
  view: DataView,
  accumulator: A,
) => T;

export type WriteDefinition<T, A = null> = (
  offset: number,
  view: DataView,
  value: T,
  accumulator: A,
) => T;

export type SingleValueReadDefinition<T, A = null> = (
  offset: number,
  view: DataView,
  accumulator: A,
) => CodecReadResult<T>;

export type SingleValueWriteDefinition<T, A = null> = (
  offset: number,
  view: DataView,
  value: T,
  accumulator: A,
) => CodecWriteResult<T>;

export type GetSizeDefinition<T, A = null> = (
  value: T,
  accumulator: A,
) => number;

export type MigrateDefinition<T> = (
  value: unknown,
  from: string,
) => T;

interface CodecDefinitionBase<
  T,
  D extends CodecDataKind,
> {
  readonly dataKind: D;
  readonly migrate?: MigrateDefinition<T>;
}

interface CodecBase<
  T,
  D extends CodecDataKind,
> {
  readonly name: string;
  readonly dataKind: D;
  readonly migrate?: MigrateDefinition<T>;
}

export interface PrimitiveCodecDefinition<T, A = null>
  extends CodecDefinitionBase<T, 'primitive'> {
  readonly size: number;
  readonly read: ReadDefinition<T, A>;
  readonly write: WriteDefinition<T, A>;
}

export interface PrimitiveCodec<T, A = null>
  extends CodecBase<T, 'primitive'> {
  readonly size: number;

  readByOffset(
    offset: number,
    view: DataView,
    accumulator?: A,
  ): T;

  readByItemIndex(
    itemIndex: number,
    view: DataView,
    accumulator?: A,
  ): T;

  writeByOffset(
    offset: number,
    view: DataView,
    value: T,
    accumulator?: A,
  ): T;

  writeByItemIndex(
    itemIndex: number,
    view: DataView,
    value: T,
    accumulator?: A,
  ): T;
}

export interface CodecFieldDefinition<T extends object> {
  readonly fieldName: CodecFieldName<T>;
  readonly codec: string;
}

export interface CodecField<T extends object, A = null> {
  readonly fieldName: CodecFieldName<T>;
  readonly offset: number;
  readonly size: number;

  readByOffset(
    offset: number,
    view: DataView,
    accumulator?: A,
  ): unknown;

  readByItemIndex(
    itemIndex: number,
    view: DataView,
    accumulator?: A,
  ): unknown;

  writeByOffset(
    offset: number,
    view: DataView,
    value: unknown,
    accumulator?: A,
  ): unknown;

  writeByItemIndex(
    itemIndex: number,
    view: DataView,
    value: unknown,
    accumulator?: A,
  ): unknown;
}

export type CodecFields<T extends object, A = null> = {
  readonly [K in CodecFieldName<T>]: CodecField<T, A>;
};

export interface FixedCountArrayCodecDefinition<
  T extends object,
  A = null,
> extends CodecDefinitionBase<T, 'fixedCountArray'> {
  readonly fieldSet: readonly CodecFieldDefinition<T>[];
}

export interface FixedCountArrayCodec<
  T extends object,
  A = null,
> extends CodecBase<T, 'fixedCountArray'> {
  readonly size: number;
  readonly fieldNames: readonly CodecFieldName<T>[];
  readonly fields: CodecFields<T, A>;

  readByOffset(
    offset: number,
    view: DataView,
    accumulator?: A,
  ): T;

  readByItemIndex(
    itemIndex: number,
    view: DataView,
    accumulator?: A,
  ): T;

  writeByOffset(
    offset: number,
    view: DataView,
    value: T,
    accumulator?: A,
  ): T;

  writeByItemIndex(
    itemIndex: number,
    view: DataView,
    value: T,
    accumulator?: A,
  ): T;
}

export interface SingleValueCodecDefinition<T, A = null>
  extends CodecDefinitionBase<T, 'singleValue'> {
  readonly getSize: GetSizeDefinition<T, A>;
  readonly read: SingleValueReadDefinition<T, A>;
  readonly write: SingleValueWriteDefinition<T, A>;
}

export interface SingleValueCodec<T, A = null>
  extends CodecBase<T, 'singleValue'> {
  getSize(value: T, accumulator?: A): number;

  readByOffset(
    offset: number,
    view: DataView,
    accumulator?: A,
  ): CodecReadResult<T>;

  writeByOffset(
    offset: number,
    view: DataView,
    value: T,
    accumulator?: A,
  ): CodecWriteResult<T>;

  encode(value: T, accumulator?: A): Uint8Array;
  decode(data: Uint8Array, accumulator?: A): T;
}

export interface SingleObjectCodecDefinition<
  T extends object,
  A = null,
> extends CodecDefinitionBase<T, 'singleObject'> {
  readonly fieldSet: readonly CodecFieldDefinition<T>[];
}

export type NullableTypedObjectCodecDefinitionInput<A = null> =
  Omit<NullableTypedObjectCodecDefinition<A>, 'dataKind'>;

export interface SingleObjectCodec<
  T extends object,
  A = null,
> extends CodecBase<T, 'singleObject'> {
  readonly fieldNames: readonly CodecFieldName<T>[];

  getSize(value: T, accumulator?: A): number;

  readByOffset(
    offset: number,
    view: DataView,
    accumulator?: A,
  ): CodecReadResult<T>;

  writeByOffset(
    offset: number,
    view: DataView,
    value: T,
    accumulator?: A,
  ): CodecWriteResult<T>;

  encode(value: T, accumulator?: A): Uint8Array;
  decode(data: Uint8Array, accumulator?: A): T;
}

export type NullableTypedObjectValue =
  Record<string, unknown> | null;

export interface NullableTypedObjectCodecDefinition<A = null>
  extends CodecDefinitionBase<
    NullableTypedObjectValue,
    'nullableTypedObject'
  > {
  readonly getSize: GetSizeDefinition<NullableTypedObjectValue, A>;

  readonly read:
    SingleValueReadDefinition<NullableTypedObjectValue, A>;

  readonly write:
    SingleValueWriteDefinition<NullableTypedObjectValue, A>;
}

export interface NullableTypedObjectCodec<A = null>
  extends CodecBase<
    NullableTypedObjectValue,
    'nullableTypedObject'
  > {
  getSize(
    value: NullableTypedObjectValue,
    accumulator?: A,
  ): number;

  readByOffset(
    offset: number,
    view: DataView,
    accumulator?: A,
  ): CodecReadResult<NullableTypedObjectValue>;

  writeByOffset(
    offset: number,
    view: DataView,
    value: NullableTypedObjectValue,
    accumulator?: A,
  ): CodecWriteResult<NullableTypedObjectValue>;

  encode(
    value: NullableTypedObjectValue,
    accumulator?: A,
  ): Uint8Array;

  decode(
    data: Uint8Array,
    accumulator?: A,
  ): NullableTypedObjectValue;
}

export interface VarCountArrayCodecDefinition<T, A = null>
  extends CodecDefinitionBase<T[], 'varCountArray'> {
  readonly countCodec: string;
  readonly itemCodec: string;
}

export interface VarCountArrayCodec<T, A = null>
  extends CodecBase<T[], 'varCountArray'> {
  getSize(value: T[], accumulator?: A): number;

  readByOffset(
    offset: number,
    view: DataView,
    accumulator?: A,
  ): CodecReadResult<T[]>;

  writeByOffset(
    offset: number,
    view: DataView,
    value: T[],
    accumulator?: A,
  ): CodecWriteResult<T[]>;

  encode(value: T[], accumulator?: A): Uint8Array;
  decode(data: Uint8Array, accumulator?: A): T[];
}

export type PrimitiveCodecDefinitionInput<T, A = null> =
  Omit<PrimitiveCodecDefinition<T, A>, 'dataKind'>;

export type FixedCountArrayCodecDefinitionInput<
  T extends object,
  A = null,
> = Omit<FixedCountArrayCodecDefinition<T, A>, 'dataKind'>;

export type SingleValueCodecDefinitionInput<T, A = null> =
  Omit<SingleValueCodecDefinition<T, A>, 'dataKind'>;

export type SingleObjectCodecDefinitionInput<
  T extends object,
  A = null,
> = Omit<SingleObjectCodecDefinition<T, A>, 'dataKind'>;

export type VarCountArrayCodecDefinitionInput<T, A = null> =
  Omit<VarCountArrayCodecDefinition<T, A>, 'dataKind'>;

export type FixedSizeCodec =
  | PrimitiveCodec<any, any>
  | FixedCountArrayCodec<any, any>;

export type VariableSizeCodec =
  | SingleValueCodec<any, any>
  | SingleObjectCodec<any, any>
  | NullableTypedObjectCodec<any>
  | VarCountArrayCodec<any, any>;

export type AnyCodecDefinition =
  | PrimitiveCodecDefinition<any, any>
  | FixedCountArrayCodecDefinition<any, any>
  | SingleValueCodecDefinition<any, any>
  | SingleObjectCodecDefinition<any, any>
  | NullableTypedObjectCodecDefinition<any>
  | VarCountArrayCodecDefinition<any, any>;

export type CodecDefinitions =
  Record<string, AnyCodecDefinition>;

export type CodecFromDefinition<D> =
  D extends PrimitiveCodecDefinition<infer T, infer A>
    ? PrimitiveCodec<T, A>
    : D extends FixedCountArrayCodecDefinition<infer T, infer A>
      ? FixedCountArrayCodec<T, A>
      : D extends SingleValueCodecDefinition<infer T, infer A>
        ? SingleValueCodec<T, A>
        : D extends SingleObjectCodecDefinition<infer T, infer A>
          ? SingleObjectCodec<T, A>
          : D extends NullableTypedObjectCodecDefinition<infer A>
            ? NullableTypedObjectCodec<A>
            : D extends VarCountArrayCodecDefinition<infer T, infer A>
              ? VarCountArrayCodec<T, A>
              : never;

export type Codecs<D extends CodecDefinitions> = {
  [K in keyof D]: CodecFromDefinition<D[K]>;
};

export type AnyCodec =
  | FixedSizeCodec
  | VariableSizeCodec;

export type CodecAccumulatorFromDefinition<D> =
  D extends PrimitiveCodecDefinition<any, infer A>
    ? A
    : D extends FixedCountArrayCodecDefinition<any, infer A>
      ? A
      : D extends SingleValueCodecDefinition<any, infer A>
        ? A
        : D extends SingleObjectCodecDefinition<any, infer A>
          ? A
          : D extends NullableTypedObjectCodecDefinition<infer A>
            ? A
            : D extends VarCountArrayCodecDefinition<any, infer A>
              ? A
              : never;

export type CodecDataFromDefinition<D> =
  D extends PrimitiveCodecDefinition<infer T, any>
    ? T
    : D extends FixedCountArrayCodecDefinition<infer T, any>
      ? T
      : D extends SingleValueCodecDefinition<infer T, any>
        ? T
        : D extends SingleObjectCodecDefinition<infer T, any>
          ? T
          : D extends NullableTypedObjectCodecDefinition<any>
            ? NullableTypedObjectValue
            : D extends VarCountArrayCodecDefinition<infer T, any>
              ? T[]
              : never;
