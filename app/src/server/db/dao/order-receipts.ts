// app/src/server/dao/order-receipts.ts

import { q, type Sql } from '../client.js';

export interface OrderReceiptRow {
  receivedAt: number;
  receiptSequence: number;
  marketName: string;
  strategyName: string;
  clientOrderId: number;
  orderKind: string;
  paperTrading: boolean;
  data: Uint8Array;
}

export class OrderReceiptsDao {
  public constructor(private readonly q: Sql) {}

  public async insert(rows: readonly OrderReceiptRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.q`
      INSERT INTO order_receipts ${this.q(
        rows.map((row) => ({
          received_at: row.receivedAt,
          receipt_sequence: row.receiptSequence,
          market_name: row.marketName,
          strategy_name: row.strategyName,
          client_order_id: row.clientOrderId,
          order_kind: row.orderKind,
          paper_trading: row.paperTrading,
          data: row.data,
        })),
        'received_at', 'receipt_sequence', 'market_name',
        'strategy_name', 'client_order_id', 'order_kind',
        'paper_trading', 'data',
      )}
      ON CONFLICT (received_at, receipt_sequence) DO NOTHING
    `;
  }
}

export const orderReceiptsDao = new OrderReceiptsDao(q);
