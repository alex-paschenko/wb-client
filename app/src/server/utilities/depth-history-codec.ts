import type { OrderBookDepth } from '../../shared/types/order-book-depth.js';
import { readCodec } from '../../shared/utilities/codecs/codecs.js';
import {
  decodeEntireBinary, encodeEntireBinary,
} from '../../shared/utilities/codecs/entire-binary-codec.js';

const CODEC = 'order book depth history v1.0' as const;

export function encodeDepthHistory(snapshots: OrderBookDepth[]): Uint8Array {
  return encodeEntireBinary({
    codecName: CODEC,
    binaryKind: 'snapshot',
    parameters: null,
    data: snapshots,
  });
}

export function decodeDepthHistory(data: Uint8Array): OrderBookDepth[] {
  const binary = decodeEntireBinary(data);
  if (
    binary.codecName !== CODEC || binary.binaryKind !== 'snapshot' ||
    binary.parameters !== null
  ) {
    throw new TypeError('Unexpected depth history binary');
  }
  const view = new DataView(
    binary.data.buffer, binary.data.byteOffset, binary.data.byteLength,
  );
  const decoded = readCodec(CODEC, 0, view);
  if (decoded.nextOffset !== view.byteLength) {
    throw new RangeError('Unexpected trailing depth history data');
  }
  return decoded.value;
}
