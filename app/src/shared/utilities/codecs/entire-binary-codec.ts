// app/src/shared/utilities/codecs/entire-binary-codec.ts

import {
  BINARY_KINDS,
  type BinaryKind,
} from '../../constants/binary-kinds.js';
import type { NullableTypedObjectValue } from '../../types/codecs.js';
import {
  getCodecEncodedSize,
  isCodecName,
  readCodec,
  writeCodec,
} from './codecs.js';
import type {
  CodecAccumulator,
  CodecData,
  CodecName,
} from './definitions/index.js';

/*
 * IMPORTANT:
 * The outer binary format is versioned through the exact codec versions
 * declared below.
 *
 * Never change the binary format of an existing codec version.
 * Add a new codec version instead.
 */

const STRING_CODEC = 'string (2^16) v1.0' as const;

const PARAMETERS_CODEC = 'typed object (nullable) v1.0' as const;

const PAYLOAD_SIZE_CODEC = 'uint32 v1.0' as const;

export type EntireBinaryParameters = NullableTypedObjectValue;

export interface EntireBinaryDataFor<
  N extends CodecName,
  P extends EntireBinaryParameters = EntireBinaryParameters,
> {
  codecName: N;
  binaryKind: BinaryKind;
  parameters: P;
  data: CodecData<N>;
}

export interface PredecodedBinary {
  codecName: CodecName;
  data: Uint8Array<ArrayBufferLike>;
}

export interface DecodedEntireBinary<
  P extends object | null = Record<string, unknown> | null,
> {
  codecName: CodecName;
  binaryKind: BinaryKind;
  parameters: P;
  data: Uint8Array<ArrayBufferLike>;
}

const isBinaryKind = (
  value: string,
): value is BinaryKind =>
  (BINARY_KINDS as readonly string[]).includes(value);

export const encodeEntireBinary = <
  N extends CodecName,
  P extends EntireBinaryParameters = EntireBinaryParameters,
>(
  value: EntireBinaryDataFor<N, P>,
  accumulator?: CodecAccumulator<N>,
): Uint8Array => {
  const { codecName, binaryKind, parameters, data } = value;

  const codecNameSize = getCodecEncodedSize(STRING_CODEC, codecName);

  const binaryKindSize = getCodecEncodedSize(STRING_CODEC, binaryKind);

  const parametersSize = getCodecEncodedSize(PARAMETERS_CODEC, parameters);

  const payloadSize = getCodecEncodedSize(codecName, data, accumulator);

  const payloadSizeSize = getCodecEncodedSize(PAYLOAD_SIZE_CODEC, payloadSize);

  const binary = new Uint8Array(
    codecNameSize +
    binaryKindSize +
    parametersSize +
    payloadSizeSize +
    payloadSize,
  );

  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);

  let offset = 0;

  offset = writeCodec(
    STRING_CODEC,
    offset,
    view,
    codecName,
  );

  offset = writeCodec(
    STRING_CODEC,
    offset,
    view,
    binaryKind,
  );

  offset = writeCodec(
    PARAMETERS_CODEC,
    offset,
    view,
    parameters,
  );

  offset = writeCodec(
    PAYLOAD_SIZE_CODEC,
    offset,
    view,
    payloadSize,
  );

  const payloadOffset = offset;

  offset = writeCodec(
    codecName,
    offset,
    view,
    data,
    accumulator,
  );

  if (offset - payloadOffset !== payloadSize) {
    throw new RangeError(
      `Codec "${codecName}" wrote ` +
      `${offset - payloadOffset} bytes, ` +
      `expected ${payloadSize}`,
    );
  }

  if (offset !== binary.byteLength) {
    throw new RangeError(
      `Entire binary wrote ${offset} bytes, ` +
      `expected ${binary.byteLength}`,
    );
  }

  return binary;
};

export const decodeEntireBinary = <
  P extends object | null = EntireBinaryParameters,
>(
  binary: Uint8Array,
): DecodedEntireBinary<P> => {
  const view = new DataView(
    binary.buffer,
    binary.byteOffset,
    binary.byteLength,
  );

  let offset = 0;

  const codecNameResult =
    readCodec(STRING_CODEC, offset, view);

  offset = codecNameResult.nextOffset;

  const codecName = codecNameResult.value;

  if (!isCodecName(codecName)) {
    throw new TypeError(
      `Unknown root codec "${codecName}"`,
    );
  }

  const binaryKindResult =
    readCodec(STRING_CODEC, offset, view);

  offset = binaryKindResult.nextOffset;

  const binaryKind = binaryKindResult.value;

  if (!isBinaryKind(binaryKind)) {
    throw new TypeError(
      `Unknown binary kind "${binaryKind}"`,
    );
  }

  const parametersResult =
    readCodec(PARAMETERS_CODEC, offset, view);

  offset = parametersResult.nextOffset;

  const payloadSizeResult =
    readCodec(PAYLOAD_SIZE_CODEC, offset, view);

  offset = payloadSizeResult.nextOffset;

  const payloadSize = payloadSizeResult.value;
  const payloadEnd = offset + payloadSize;

  if (payloadEnd > binary.byteLength) {
    throw new RangeError(
      `Payload exceeds binary size: ${payloadSize} bytes`,
    );
  }

  if (payloadEnd !== binary.byteLength) {
    throw new RangeError(
      `Entire binary contains ` +
      `${binary.byteLength - payloadEnd} trailing bytes`,
    );
  }

  return {
    codecName,
    binaryKind,
    parameters: parametersResult.value as P,
    data: binary.subarray(offset, payloadEnd),
  };
};
