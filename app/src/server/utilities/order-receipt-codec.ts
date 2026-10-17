import type { OrderReceiptBody } from '../../shared/types/order-receipt.js';
import { readCodec } from '../../shared/utilities/codecs/codecs.js';
import {
  decodeEntireBinary, encodeEntireBinary,
} from '../../shared/utilities/codecs/entire-binary-codec.js';

export type { OrderReceiptBody } from '../../shared/types/order-receipt.js';

const CODEC = 'order receipt v1.0' as const;

export function encodeOrderReceipt(receipt: OrderReceiptBody): Uint8Array {
  return encodeEntireBinary({
    codecName: CODEC,
    binaryKind: 'snapshot',
    parameters: null,
    data: receipt,
  });
}

export function decodeOrderReceipt(data: Uint8Array): OrderReceiptBody {
  const binary = decodeEntireBinary(data);
  if (
    binary.codecName !== CODEC || binary.binaryKind !== 'snapshot' ||
    binary.parameters !== null
  ) {
    throw new TypeError('Unexpected order receipt binary');
  }
  const view = new DataView(
    binary.data.buffer, binary.data.byteOffset, binary.data.byteLength,
  );
  const decoded = readCodec(CODEC, 0, view);
  if (decoded.nextOffset !== view.byteLength) {
    throw new RangeError('Unexpected trailing order receipt data');
  }
  return decoded.value;
}
