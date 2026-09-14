// app/src/shared/utilities/codecs/definitions/codec-definition-helpers.ts

import {
  FixedCountArrayCodecDefinition,
  FixedCountArrayCodecDefinitionInput,
  NullableTypedObjectCodecDefinition,
  NullableTypedObjectCodecDefinitionInput,
  PrimitiveCodecDefinition,
  PrimitiveCodecDefinitionInput,
  SingleObjectCodecDefinition,
  SingleObjectCodecDefinitionInput,
  SingleValueCodecDefinition,
  SingleValueCodecDefinitionInput,
  VarCountArrayCodecDefinition,
  VarCountArrayCodecDefinitionInput
} from '../../../types/codecs';

export const primitiveCodecDefinition = <T, A = null>(
  definition: PrimitiveCodecDefinitionInput<T, A>,
): PrimitiveCodecDefinition<T, A> => ({
  ...definition,
  dataKind: 'primitive',
});

export const fixedCountArrayCodecDefinition = <
  T extends object,
  A = null,
>(
  definition: FixedCountArrayCodecDefinitionInput<T, A>,
): FixedCountArrayCodecDefinition<T, A> => ({
  ...definition,
  dataKind: 'fixedCountArray',
});

export const singleValueCodecDefinition = <T, A = null>(
  definition: SingleValueCodecDefinitionInput<T, A>,
): SingleValueCodecDefinition<T, A> => ({
  ...definition,
  dataKind: 'singleValue',
});

export const singleObjectCodecDefinition = <
  T extends object,
  A = null,
>(
  definition: SingleObjectCodecDefinitionInput<T, A>,
): SingleObjectCodecDefinition<T, A> => ({
  ...definition,
  dataKind: 'singleObject',
});

export const nullableTypedObjectCodecDefinition = <A = null>(
  definition: NullableTypedObjectCodecDefinitionInput<A>,
): NullableTypedObjectCodecDefinition<A> => ({
  ...definition,
  dataKind: 'nullableTypedObject',
});

export const varCountArrayCodecDefinition = <T, A = null>(
  definition: VarCountArrayCodecDefinitionInput<T, A>,
): VarCountArrayCodecDefinition<T, A> => ({
  ...definition,
  dataKind: 'varCountArray',
});
