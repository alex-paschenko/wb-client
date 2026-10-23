// app/src/server/whitebit/order-adapter.ts

import {
  orderPositionSideNames,
  orderSides,
  orderStatusNames,
  orderStpNames,
  orderTypes,
} from '../../shared/constants/orders.js';
import type {
  Order,
  OrderError,
} from '../../shared/types/order-receipt.js';
import type { OrderCancel, OrderCreateRequest } from '../types/orders.js';

type ObjectValue = Record<string, unknown>;

function objectValue(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid WhiteBIT order object');
  }
  return value as ObjectValue;
}

function numberValue(value: unknown, name: string): number {
  const result = typeof value === 'number' ? value :
    typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(result)) {
    throw new Error('Invalid WhiteBIT order field: ' + name);
  }
  return result;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function member<const T extends readonly string[]>(
  values: T, value: unknown, name: string,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error('Invalid WhiteBIT order enum: ' + name);
  }
  return value as T[number];
}

function decimal(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('WhiteBIT order amount/price must be positive');
  }
  // Internal amounts remain numbers; only the wire boundary uses strings.
  // Convert exponent notation into plain decimal form (no rounding).
  const str = String(value);
  if (!/[eE]/.test(str)) {
    return str;
  }

  const [mantissa, exponentStr] = str.toLowerCase().split('e');
  const exponent = Number(exponentStr);
  const negative = mantissa.startsWith('-');
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const dot = unsigned.indexOf('.');
  const places = dot < 0 ? unsigned.length : dot;
  const digits = unsigned.replace('.', '');
  const point = places + exponent;
  const plain = point <= 0 ? '0.' + '0'.repeat(-point) + digits :
    point >= digits.length ? digits + '0'.repeat(point - digits.length) :
    digits.slice(0, point) + '.' + digits.slice(point);

  return negative ? '-' + plain : plain;
}

export function toWhitebitOrderRequest(command: OrderCreateRequest): {
  method: string;
  params: unknown[];
} {
  const { orderRequest: request } = command;
  const params: Record<string, unknown> = {
    market: request.marketName,
    side: request.side,
    amount: decimal(request.amount),
    client_order_id: String(request.client_order_id),
  };

  if (request.stp) {
    params.stp = request.stp;
  }

  if (command.orderType === 'Limit') {
    params.price = decimal(command.orderRequest.price);
  }

  return {
    method: command.orderType === 'Limit'
      ? 'order_limit_place'
      : 'order_market_place',
    params: [params],
  };
}

export function toWhitebitCancelRequest(request: OrderCancel): unknown[] {
  return [{
    market: request.market,
    client_order_id: String(request.client_order_id),
  }];
}

export function fromWhitebitOrder(raw: unknown): Order {
  const o = objectValue(raw);

  if (typeof o.type !== 'number' || typeof o.side !== 'number') {
    throw new Error('Invalid WhiteBIT order type/side');
  }

  const type = orderTypes[o.type as keyof typeof orderTypes];
  const side = orderSides[o.side as keyof typeof orderSides];

  if (!type || !side) {
    throw new Error('Unknown WhiteBIT order type/side');
  }

  return {
    id: numberValue(o.id, 'id'),
    client_order_id: numberValue(o.client_order_id, 'client_order_id'),
    market: String(o.market ?? ''),
    type,
    side,
    status: member(orderStatusNames, o.status, 'status'),
    price: numberValue(o.price, 'price'),
    amount: numberValue(o.amount, 'amount'),
    left: numberValue(o.left, 'left'),
    deal_stock: numberValue(o.deal_stock, 'deal_stock'),
    deal_money: numberValue(o.deal_money, 'deal_money'),
    deal_fee: numberValue(o.deal_fee, 'deal_fee'),
    ctime: numberValue(o.ctime, 'ctime'),
    mtime: numberValue(o.mtime, 'mtime'),
    post_only: booleanValue(o.post_only),
    ioc: booleanValue(o.ioc),
    stp: member(orderStpNames, o.stp ?? 'no', 'stp'),
    position_side: member(
      orderPositionSideNames, o.position_side ?? 'BOTH', 'position_side',
    ),
    rpi: booleanValue(o.rpi),
    retail: booleanValue(o.retail),
    reduce_only: booleanValue(o.reduce_only),
  };
}

export function fromWhitebitOrderError(raw: unknown): OrderError {
  const e = objectValue(raw);
  if (typeof e.code !== 'number' || !Number.isInteger(e.code) ||
    e.code < -0x80000000 || e.code > 0x7fffffff) {
    throw new TypeError('Invalid WhiteBIT order error code');
  }
  return { code: e.code, isWBError: true };
}
