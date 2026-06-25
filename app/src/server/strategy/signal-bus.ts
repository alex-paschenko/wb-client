import type {
  StrategySignalBucket,
  StrategySignalState,
} from '../../shared/types/signal.js';

import { signalProcessor } from './signal-processor.js';

type SignalProcessorFn = (
  snapshot: ReadonlyMap<string, StrategySignalBucket>,
) => Promise<void>;

export class SignalBus {
  private readonly states =
    new Map<string, StrategySignalBucket>();

  private isProcessorRunning = false;

  private isDirty = false;

  public constructor(
    private readonly processSignals: SignalProcessorFn,
  ) {}

  public setState(
    state: StrategySignalState,
  ): void {
    const key = this.getKey(
      state.strategy,
      state.symbol,
    );

    const snapshot =
      this.states.get(key);

    const bucket: StrategySignalBucket =
      snapshot
        ? {
            prev: snapshot.current,
            current: state,
          }
        : {
            prev: state,
            current: state,
          };

    this.states.set(key, bucket);

    if (
      bucket.prev.side !==
      bucket.current.side
    ) {
      this.isDirty = true;
      void this.runProcessor();
    }
  }

  public getState(
    strategy: string,
    symbol: string,
  ): StrategySignalBucket | null {
    return (
      this.states.get(
        this.getKey(strategy, symbol),
      ) ?? null
    );
  }

  public getSnapshot():
    ReadonlyMap<string, StrategySignalBucket> {
    return this.cloneStates();
  }

  private async runProcessor(): Promise<void> {
    if (this.isProcessorRunning) {
      return;
    }

    this.isProcessorRunning = true;

    try {
      while (this.isDirty) {
        this.isDirty = false;

        await this.processSignals(
          this.cloneStates(),
        );
      }
    } catch (error) {
      console.error(
        'Signal processor failed',
        error,
      );
    } finally {
      this.isProcessorRunning = false;
    }
  }

  private cloneStates():
    ReadonlyMap<string, StrategySignalBucket> {
    return new Map(
      [...this.states.entries()].map(
        ([key, bucket]) => [
          key,
          {
            prev: { ...bucket.prev },
            current: { ...bucket.current },
          },
        ],
      ),
    );
  }

  private getKey(
    strategy: string,
    symbol: string,
  ): string {
    return `${strategy}:${symbol}`;
  }
}

export const signalBus = new SignalBus(
  (snapshot) =>
    signalProcessor.process(snapshot),
);
