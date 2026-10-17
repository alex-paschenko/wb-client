// app/src/server/services/depth-persistence.ts

import { SERVER_EVENT } from '../constants/events.js';
import {
  orderBookDepthDao,
  type DepthRow,
} from '../dao/order-book-depth.js';
import { eventBus } from './event-bus.js';
import { ReliablePersistenceQueue } from './reliable-persistence-queue.js';

export class DepthPersistenceService {
  private nextSequence = 0;
  private unsubscribe: (() => void) | null = null;
  private readonly queue = new ReliablePersistenceQueue(
    'Order book depth',
    (batch: readonly DepthRow[]) => orderBookDepthDao.insert(batch),
  );

  public start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = eventBus.on(
      SERVER_EVENT.depthPersistenceRequest,
      (event) => {
        this.queue.enqueue({
          ...event,
          depthSequence: ++this.nextSequence,
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

export const depthPersistence = new DepthPersistenceService();
