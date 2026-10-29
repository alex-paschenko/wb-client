// app/src/shared/utilities/codecs/definitions/depth-history-v1_0.ts

import type { OrderBookDepthBet, OrderBookDepthHistoryItem } from '../../../types/order-book-depth.js';
import { singleValueCodecDefinition } from './codec-definition-helpers.js';

const HEADER_SIZE = 4;
const SNAPSHOT_SIZE = 36;
const LEVEL_SIZE = 16;

export const depthHistory_V1_0 = singleValueCodecDefinition<OrderBookDepthHistoryItem[]>({
  getSize: (snapshots) => {
    if (snapshots.length > 0xffffffff) throw new RangeError('Too many depth snapshots');
    let size = HEADER_SIZE;
    for (const snapshot of snapshots) {
      if (snapshot.asks.length > 0xffff || snapshot.bids.length > 0xffff) {
        throw new RangeError('Too many depth levels');
      }
      size += SNAPSHOT_SIZE + LEVEL_SIZE * (snapshot.asks.length + snapshot.bids.length);
    }
    return size;
  },
  write: (offset, view, snapshots) => {
    view.setUint32(offset, snapshots.length, true);
    offset += HEADER_SIZE;
    for (const snapshot of snapshots) {
      if (!Number.isSafeInteger(snapshot.receivedAt) ||
        !Number.isSafeInteger(snapshot.arrivedAt)) {
        throw new RangeError('Invalid depth timestamps');
      }
      view.setFloat64(offset, snapshot.receivedAt, true);
      view.setFloat64(offset + 8, snapshot.arrivedAt, true);
      view.setFloat64(offset + 16, snapshot.timestamp, true);
      view.setFloat64(offset + 24, snapshot.event_time, true);
      view.setUint16(offset + 32, snapshot.asks.length, true);
      view.setUint16(offset + 34, snapshot.bids.length, true);
      offset += SNAPSHOT_SIZE;
      for (const side of [snapshot.asks, snapshot.bids]) {
        for (const [price, amount] of side) {
          view.setFloat64(offset, price, true);
          view.setFloat64(offset + 8, amount, true);
          offset += LEVEL_SIZE;
        }
      }
    }
    return { value: snapshots, nextOffset: offset };
  },
  read: (offset, view) => {
    if (offset + HEADER_SIZE > view.byteLength) throw new RangeError('Truncated depth count');
    const count = view.getUint32(offset, true);
    offset += HEADER_SIZE;
    if (count > Math.floor((view.byteLength - offset) / SNAPSHOT_SIZE)) {
      throw new RangeError('Truncated depth history');
    }
    const result: OrderBookDepthHistoryItem[] = [];
    for (let i = 0; i < count; i++) {
      if (offset + SNAPSHOT_SIZE > view.byteLength) throw new RangeError('Truncated depth snapshot');
      const receivedAt = view.getFloat64(offset, true);
      const arrivedAt = view.getFloat64(offset + 8, true);
      const timestamp = view.getFloat64(offset + 16, true);
      const event_time = view.getFloat64(offset + 24, true);
      const asksCount = view.getUint16(offset + 32, true);
      const bidsCount = view.getUint16(offset + 34, true);
      if (!Number.isSafeInteger(receivedAt) || !Number.isSafeInteger(arrivedAt)) {
        throw new RangeError('Invalid depth timestamps');
      }
      offset += SNAPSHOT_SIZE;
      const readSide = (length: number): OrderBookDepthBet[] => {
        if (length > Math.floor((view.byteLength - offset) / LEVEL_SIZE)) {
          throw new RangeError('Truncated depth levels');
        }
        const side: OrderBookDepthBet[] = [];
        for (let j = 0; j < length; j++) {
          side.push([view.getFloat64(offset, true), view.getFloat64(offset + 8, true)]);
          offset += LEVEL_SIZE;
        }
        return side;
      };
      result.push({ receivedAt, arrivedAt, timestamp, event_time,
        asks: readSide(asksCount), bids: readSide(bidsCount) });
    }
    return { value: result, nextOffset: offset };
  },
});
