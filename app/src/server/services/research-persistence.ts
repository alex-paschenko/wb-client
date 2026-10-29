import { SERVER_EVENT } from '../constants/events.js';
import type { ResearchSnapshot } from '../../shared/types/research-storage.js';
import { researchStorageDao } from '../db/dao/research-storage.js';
import { eventBus } from './event-bus.js';
import { ReliablePersistenceQueue } from './reliable-persistence-queue.js';

export class ResearchPersistenceService {
  private unsubscribe: (() => void) | null = null;
  private readonly queue = new ReliablePersistenceQueue<ResearchSnapshot>(
    'Research storage',
    (batch) => researchStorageDao.insert(batch),
  );

  public start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = eventBus.on(SERVER_EVENT.researchPersistenceRequest,
      (snapshot) => this.queue.enqueue(snapshot));
  }

  public async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.queue.stop();
  }
}

export const researchPersistence = new ResearchPersistenceService();
