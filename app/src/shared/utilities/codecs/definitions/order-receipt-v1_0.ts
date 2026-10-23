// app/src/shared/utilities/codecs/definitions/order-receipt-v1_0.ts

import {
  orderTypeNames,
  orderSideNames,
  orderStpNames,
  orderStatusNames,
  orderPositionSideNames,
} from '../../../constants/orders.js';
import type {
  Order, OrderError, OrderReceiptBody,
} from '../../../types/order-receipt.js';
import { singleValueCodecDefinition } from './codec-definition-helpers.js';

// Byte 0: presence bits (order, error). An order has ten float64 values,
// six length-prefixed UTF-8 strings and one byte of boolean flags.
// An error is one byte isWBError followed by one signed int32 code (LE).
// This v1.0 layout is finalized before any receipts are persisted.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const numberFields = [
  'id',
  'ctime',
  'mtime',
  'price',
  'amount',
  'left',
  'deal_stock',
  'deal_money',
  'deal_fee',
  'client_order_id',
] as const satisfies readonly (keyof Order)[];
const stringFields = [
  'market', 'type', 'side', 'stp', 'status', 'position_side',
] as const satisfies readonly (keyof Order)[];

function checked<T extends string>(value: string, values: readonly T[]): T {
  if (!values.includes(value as T)) {
    throw new TypeError(`Invalid order receipt value: ${value}`);
  }

  return value as T;
}

function stringSize(value: string): number {
  const length = encoder.encode(value).length;
  if (length > 0xffffffff) {
    throw new RangeError('Order receipt string too long');
  }

  return 4 + length;
}

class Writer {
  constructor(public offset: number, private readonly view: DataView) {}

  byte(value: number): void {
    this.view.setUint8(this.offset++, value);
  }

  int32(value: number): void {
    if (!Number.isInteger(value) ||
      value < -0x80000000 || value > 0x7fffffff) {
      throw new RangeError('Invalid order error code: expected int32');
    }
    this.view.setInt32(this.offset, value, true);
    this.offset += 4;
  }

  float64(value: number): void {
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  string(value: string): void {
    const bytes = encoder.encode(value);
    if (bytes.length > 0xffffffff) {
      throw new RangeError('Order receipt string too long');
    }

    this.view.setUint32(this.offset, bytes.length, true);
    this.offset += 4;

    new Uint8Array(
      this.view.buffer, this.view.byteOffset + this.offset, bytes.length,
    ).set(bytes);

    this.offset += bytes.length;
  }
}

class Reader {
  constructor(public offset: number, private readonly view: DataView) {}

  private require(length: number): void {
    if (length > this.view.byteLength - this.offset) {
      throw new RangeError('Truncated order receipt');
    }
  }

  byte(): number {
    this.require(1);
    return this.view.getUint8(this.offset++);
  }

  int32(): number {
    this.require(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  float64(): number {
    this.require(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  string(): string {
    this.require(4);

    const length = this.view.getUint32(this.offset, true);
    this.offset += 4;

    this.require(length);

    const value = decoder.decode(new Uint8Array(
      this.view.buffer, this.view.byteOffset + this.offset, length,
    ));

    this.offset += length;

    return value;
  }
}

function readOrder(reader: Reader): Order {
  const [
    id,
    ctime,
    mtime,
    price,
    amount,
    left,
    deal_stock,
    deal_money,
    deal_fee,
    client_order_id,
  ] = numberFields.map(() => reader.float64());

  const [market, type, side, stp, status, position_side] =
    stringFields.map(() => reader.string());

  const flags = reader.byte();
  if (flags & ~0x1f) {
    throw new TypeError('Invalid order receipt flags');
  }

  return {
    id,
    ctime,
    mtime,
    price,
    amount,
    left,
    deal_stock,
    deal_money,
    deal_fee,
    client_order_id,
    market,
    type: checked(type, orderTypeNames),
    side: checked(side, orderSideNames),
    stp: checked(stp, orderStpNames),
    status: checked(status, orderStatusNames),
    position_side: checked(position_side, orderPositionSideNames),
    post_only: !!(flags & 1),
    ioc: !!(flags & 2),
    rpi: !!(flags & 4),
    retail: !!(flags & 8),
    reduce_only: !!(flags & 16),
  };
}

export const orderReceipt_V1_0 =
  singleValueCodecDefinition<OrderReceiptBody>({
    getSize: ({ order, error }) => {
      let size = 1;

      if (order) {
        size += numberFields.length * 8 + 1;

        for (const field of stringFields) {
          size += stringSize(order[field]);
        }
      }

      if (error) size += 1 + 4;
      return size;
    },
    write: (offset, view, value) => {
      const writer = new Writer(offset, view);
      writer.byte((value.order ? 1 : 0) | (value.error ? 2 : 0));
      if (value.order) {
        for (const field of numberFields) {
          writer.float64(value.order[field]);
        }

        for (const field of stringFields) {
          writer.string(value.order[field]);
        }

        const order = value.order;

        writer.byte(
          (order.post_only ? 1 : 0) | (order.ioc ? 2 : 0) |
          (order.rpi ? 4 : 0) | (order.retail ? 8 : 0) |
          (order.reduce_only ? 16 : 0),
        );
      }

      if (value.error) {
        writer.byte(value.error.isWBError ? 1 : 0);
        writer.int32(value.error.code);
      }
      return { value, nextOffset: writer.offset };
    },

    read: (offset, view) => {
      const reader = new Reader(offset, view);

      const presence = reader.byte();
      if (presence & ~3) {
        throw new TypeError('Invalid order receipt presence');
      }

      const order = presence & 1 ? readOrder(reader) : null;
      let error: OrderError | null = null;

      if (presence & 2) {
        const source = reader.byte();
        if (source !== 0 && source !== 1) {
          throw new TypeError('Invalid order error source');
        }
        error = { isWBError: source === 1, code: reader.int32() };
      }
      return { value: { order, error }, nextOffset: reader.offset };
    },
  });
