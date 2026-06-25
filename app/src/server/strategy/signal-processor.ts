import type { StrategySignalBucket } from '../../shared/types/signal.js';
import { getWsServer } from '../frontend/index.js';

export type SignalProcessorSnapshot =
  ReadonlyMap<string, StrategySignalBucket>;

export class SignalProcessor {
  public async process(
    snapshot: SignalProcessorSnapshot,
  ): Promise<void> {
    for (const [key, bucket] of snapshot) {
      if (bucket.prev.side === bucket.current.side) {
        continue;
      }

      getWsServer().broadcast({
        type: 'signal-changed',
        strategy: bucket.current.strategy,
        symbol: bucket.current.symbol,
        side: bucket.current.side,
        price:
          bucket.current.side === 'none'
            ? null
            : bucket.current.price,
        exchangeTimestampMs: bucket.current.exchangeTimestampMs,
      });

      console.log('Signal state changed', {
        key,
        from: bucket.prev.side,
        to: bucket.current.side,
        current: bucket.current,
      });
    }
  }
}

export const signalProcessor = new SignalProcessor();
