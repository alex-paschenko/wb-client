// app/src/server/services/order-persistence.ts

import { SERVER_EVENT } from '../constants/events.js';
import {
  orderReceiptsDao,
  type OrderReceiptRow,
} from '../dao/order-receipts.js';
import { encodeOrderReceipt } from '../utilities/order-receipt-codec.js';
import { eventBus } from './event-bus.js';
import { ReliablePersistenceQueue } from './reliable-persistence-queue.js';

export class OrderPersistence {
  private nextSequence = 0;

  private unsubscribe: (() => void) | null = null;

  private readonly queue = new ReliablePersistenceQueue(
    'Order receipts',
    (batch: readonly OrderReceiptRow[]) => orderReceiptsDao.insert(batch),
  );

  public start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = eventBus.on(
      SERVER_EVENT.orderPersistenceRequest,
      (event) => {
        this.queue.enqueue({
          receivedAt: event.receivedAt,
          receiptSequence: ++this.nextSequence,
          marketName: event.marketName,
          strategyName: event.strategyName,
          clientOrderId: event.client_order_id,
          orderKind: event.orderKind,
          paperTrading: event.paperTrading,
          data: encodeOrderReceipt({
            order: event.order,
            error: event.error,
          }),
        });
      },
    );
  }

  public async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    
    await this.queue.stop();
  }
}

export const orderPersistence = new OrderPersistence();
