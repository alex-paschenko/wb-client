// app/src/server/services/reliable-persistence-queue.ts

import { pause } from '../../shared/utilities/awaiters';
import { isCpuProfiling } from '../constants/persistence.js';

const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 8;
const BASE_DELAY = 100;
const MAX_DELAY = 5_000;

export class ReliablePersistenceQueue<T> {
  private readonly pending: T[] = [];

  private timer: ReturnType<typeof setTimeout> | null = null;

  private running: Promise<void> | null = null;

  private failures = 0;

  private stopping = false;

  public constructor(
    private readonly name: string,
    private readonly write: (items: readonly T[]) => Promise<void>,
  ) {}

  public enqueue(item: T): void {
    if (this.stopping) {
      throw new Error(this.name + ' queue has stopped');
    }

    this.pending.push(item);
    this.schedule(0);
  }

  public async stop(): Promise<void> {
    this.stopping = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    while (this.running || this.pending.length > 0) {
      if (this.running) {
        await this.running;
      } else {
        if (this.failures >= MAX_ATTEMPTS) {
          throw new Error(this.name + ' persistence failed permanently');
        }

        if (this.failures > 0) {
          await pause(this.retryDelay());
        }

        await this.process();
      }
    }
  }

  private schedule(delay: number): void {
    if (
      this.stopping ||
      this.running ||
      this.timer ||
      this.pending.length === 0 ||
      this.failures >= MAX_ATTEMPTS
    ) {
      return;
    }

    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.process();
      },
      delay,
    );
  }

  private async process(): Promise<void> {
    if (this.running) {
      return this.running;
    }

    if (this.pending.length === 0) {
      return;
    }

    const batch = this.pending.slice(0, BATCH_SIZE);

    const task = (async () => {
      try {
        if (isCpuProfiling) {
          await pause(10);
        } else {
          await this.write(batch);
        }
        this.pending.splice(0, batch.length);
        this.failures = 0;
      } catch (error) {
        this.failures++;

        console.error(this.name + ' persistence failed', {
          error, attempt: this.failures, queued: this.pending.length,
        });
      }
    })();

    this.running = task;
    
    try {
      await task;
    } finally {
      this.running = null;
      this.schedule(this.failures > 0 ? this.retryDelay() : 0);
    }
  }

  private retryDelay(): number {
    return Math.min(BASE_DELAY * 2 ** (this.failures - 1), MAX_DELAY);
  }
}
