// app/src/shared/utilities/codecs/definitions/index.ts

import { uint16Nullable_V1_0 } from './uint16-nullable-v1_0.js';
import { string2To16_V1_0 } from './string-2-to-16-v1_0.js';
import { uint16_V1_0 } from './uint16-v1_0.js';
import { int16Nullable_V1_0 } from './int16-nullable-v1_0.js';
import { float16Nullable_V1_0 } from './float16-nullable-v1_0.js';
import { uint32_V1_0 } from './uint32-v1_0.js';
import { float32Nullable_V1_0 } from './float32-nullable-v1_0.js';
import { float64Nullable_V1_0 } from './float64-nullable-v1_0.js';
import { candle_V1_0 } from './candle-v1_0.js';
import { delta_V1_0 } from './delta-v1_0.js';
import { frontendWs_V1_0 } from './frontend-ws-v1_0.js';
import { snapshot_V1_0 } from './snapshot-v1_0.js';
import { nullableTypedObject_V1_0 } from './nullable-typed-object-v1_0.js';
import type {
  AnyCodec,
  CodecAccumulatorFromDefinition,
  CodecDataFromDefinition,
} from '../../../types/codecs.js';

export const CODEC_DEFINITIONS = {
  'string (2^16) v1.0': string2To16_V1_0,

  'typed object (nullable) v1.0': nullableTypedObject_V1_0,

  'uint16 v1.0': uint16_V1_0,

  'uint16 (nullable) v1.0': uint16Nullable_V1_0,

  'int16 (nullable) v1.0': int16Nullable_V1_0,

  'float16 (nullable) v1.0': float16Nullable_V1_0,

  'uint32 v1.0': uint32_V1_0,

  'float32 (nullable) v1.0': float32Nullable_V1_0,

  'float64 (nullable) v1.0': float64Nullable_V1_0,

  'candle v1.0': candle_V1_0,

  'snapshot v1.0': snapshot_V1_0,

  'delta v1.0': delta_V1_0,

  'frontend ws v1.0': frontendWs_V1_0,
} as const;


export type CodecDefinitions = typeof CODEC_DEFINITIONS;

export type CodecName = keyof CodecDefinitions;

export const validEntityCodecDataKinds = [
  'primitive',
  'fixedCountArray',
] as const satisfies readonly AnyCodec['dataKind'][];

type EntityCodecDataKind =
  typeof validEntityCodecDataKinds[number];

export type EntityCodecName = {
  [N in CodecName]:
    CodecDefinitions[N]['dataKind'] extends EntityCodecDataKind
      ? N
      : never;
}[CodecName];

export type CodecData<N extends CodecName> =
  CodecDataFromDefinition<CodecDefinitions[N]>;

export type CodecAccumulator<N extends CodecName> =
  CodecAccumulatorFromDefinition<CodecDefinitions[N]>;
