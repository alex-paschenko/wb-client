// app/src/server/dao/order-book-depth.ts

import { q, type Sql } from '../client.js';
import type { DepthPersistence } from '../../types/persistence.js';

export interface DepthRow extends DepthPersistence {
  depthSequence: number;
}

export class OrderBookDepthDao {
  public constructor(private readonly q: Sql) {}

  public async insert(rows: readonly DepthRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.q`
      INSERT INTO order_book_depth_history ${this.q(
        rows.map((row) => ({
          market_name: row.marketName,
          start_received_at: row.startReceivedAt,
          received_at: row.receivedAt,
          depth_sequence: row.depthSequence,
          data: row.data,
        })),
        'market_name', 'start_received_at', 'received_at', 'depth_sequence', 'data',
      )}
      ON CONFLICT (start_received_at, depth_sequence) DO NOTHING
    `;
  }
}

export const orderBookDepthDao = new OrderBookDepthDao(q);
