// app/src/shared/utilities/codecs/definitions/depth-history-v1_0.ts

import type {
  OrderBookDepth, OrderBookDepthBet,
} from '../../../types/order-book-depth.js';
import { singleValueCodecDefinition } from './codec-definition-helpers.js';

// uint32 snapshot count; each snapshot has two float64 times, uint16 counts
// for asks and bids, followed by float64 price/amount pairs for each side.
// Once released, change the name/version to change this layout.
const HEADER_SIZE = 4;
const SNAPSHOT_SIZE = 20;
const LEVEL_SIZE = 16;

export const depthHistory_V1_0 = singleValueCodecDefinition<OrderBookDepth[]>({
  getSize: (snapshots) => {
    if (snapshots.length > 0xffffffff) {
      throw new RangeError('Too many depth snapshots');
    }

    let size = HEADER_SIZE;

    for (const snapshot of snapshots) {
      if (snapshot.asks.length > 0xffff || snapshot.bids.length > 0xffff) {
        throw new RangeError('Too many depth levels');
      }

      size += SNAPSHOT_SIZE +
        LEVEL_SIZE * (snapshot.asks.length + snapshot.bids.length);
    }

    return size;
  },
  write: (offset, view, snapshots) => {
    view.setUint32(offset, snapshots.length, true);
    offset += HEADER_SIZE;

    for (const snapshot of snapshots) {
      view.setFloat64(offset, snapshot.timestamp, true);
      view.setFloat64(offset + 8, snapshot.event_time, true);
      view.setUint16(offset + 16, snapshot.asks.length, true);
      view.setUint16(offset + 18, snapshot.bids.length, true);
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
    if (offset + HEADER_SIZE > view.byteLength) {
      throw new RangeError('Truncated depth history');
    }

    const count = view.getUint32(offset, true);
    offset += HEADER_SIZE;
    if (count > Math.floor((view.byteLength - offset) / SNAPSHOT_SIZE)) {
      throw new RangeError('Truncated depth snapshots');
    }

    const snapshots: OrderBookDepth[] = [];

    for (let i = 0; i < count; i++) {
      if (offset + SNAPSHOT_SIZE > view.byteLength) {
        throw new RangeError('Truncated depth snapshot');
      }

      const timestamp = view.getFloat64(offset, true);
      const event_time = view.getFloat64(offset + 8, true);
      const asksCount = view.getUint16(offset + 16, true);
      const bidsCount = view.getUint16(offset + 18, true);
      offset += SNAPSHOT_SIZE;

      const readSide = (length: number): OrderBookDepthBet[] => {
        if (length > Math.floor((view.byteLength - offset) / LEVEL_SIZE)) {
          throw new RangeError('Truncated depth levels');
        }

        const side: OrderBookDepthBet[] = [];

        for (let j = 0; j < length; j++) {
          side.push([
            view.getFloat64(offset, true),
            view.getFloat64(offset + 8, true),
          ]);
          offset += LEVEL_SIZE;
        }

        return side;
      };

      snapshots.push({
        timestamp, event_time,
        asks: readSide(asksCount), bids: readSide(bidsCount),
      });
    }

    return { value: snapshots, nextOffset: offset };
  },
});
