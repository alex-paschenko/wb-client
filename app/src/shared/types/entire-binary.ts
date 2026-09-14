// app/src/shared/types/entire-binary.ts

import type { BinaryKind } from '../constants/binary-kinds.js';
import type { CodecData, CodecName } from '../utilities/codecs/definitions/index.js';

export type EntireBinaryDataFor<N extends CodecName> = {
  codecName: N;
  binaryKind: BinaryKind;
  data: CodecData<N>;
};

export type EntireBinaryData = {
  [N in CodecName]: EntireBinaryDataFor<N>;
}[CodecName];
