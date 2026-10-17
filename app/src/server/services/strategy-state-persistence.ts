import { SERVER_EVENT } from '../constants/events.js';
import {
  strategyStateDao,
  type StrategyStateRow,
} from '../dao/strategy-state.js';
import { eventBus } from './event-bus.js';
import { ReliablePersistenceQueue } from './reliable-persistence-queue.js';

export class StrategyStatePersistence {
  private nextSequence = 0;
  private unsubscribe: (() => void) | null = null;
  private readonly queue = new ReliablePersistenceQueue(
    'Strategy states',
    (batch: readonly StrategyStateRow[]) => strategyStateDao.insert(batch),
  );

  public start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = eventBus.on(
      SERVER_EVENT.strategyStatePersistenceRequest,
      ({ changes }) => {
        for (const change of changes) {
          this.queue.enqueue({
            ...change,
            stateSequence: ++this.nextSequence,
          });
        }
      },
    );
  }

  public async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.queue.stop();
  }
}

export const strategyStatePersistence =
  new StrategyStatePersistence();
