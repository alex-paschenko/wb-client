import { SECONDS } from '../../../shared/constants/time.js';
import type { SignalSide, StrategySignalState } from '../../../shared/types/signal.js';
import type { StrategyTickContext, TradingStrategy } from '../../types/strategy.js';

import { signalBus } from '../signal-bus.js';

export class MomentumReversalStrategy implements TradingStrategy {
  public readonly name = 'momentum-reversal';

  private readonly intervalMs = 15 * SECONDS;

  private readonly buyThresholdPercent = -0.15;

  private readonly sellThresholdPercent = 0.15;

  public async onTick(context: StrategyTickContext): Promise<void> {
    const sellDelta = context.store.getPriceDelta(
      context.tick.symbol,
      this.intervalMs,
      (tick) => tick.price.takerSellPrice,
    );

    const sellHighLow = context.store.getHighLow(
      context.tick.symbol,
      this.intervalMs,
      (tick) => tick.price.takerSellPrice,
    );

    const buyDelta = context.store.getPriceDelta(
      context.tick.symbol,
      this.intervalMs,
      (tick) => tick.price.takerBuyPrice,
    );

    const buyHighLow = context.store.getHighLow(
      context.tick.symbol,
      this.intervalMs,
      (tick) => tick.price.takerBuyPrice,
    );

    let side: SignalSide = 'none';

    if (
      sellDelta &&
      sellHighLow &&
      sellDelta.percent >= this.sellThresholdPercent &&
      context.tick.price.takerSellPrice >= sellHighLow.high
    ) {
      side = 'sell';
    } else if (
      buyDelta &&
      buyHighLow &&
      buyDelta.percent <= this.buyThresholdPercent &&
      context.tick.price.takerBuyPrice <= buyHighLow.low
    ) {
      side = 'buy';
    }

    const newState: StrategySignalState =
      side === 'none'
        ? {
            strategy: this.name,
            symbol: context.tick.symbol,
            side,
            price: context.tick.price.rawPrice,
            exchangeTimestampMs: context.tick.exchangeTimestampMs,
          }
        : {
            strategy: this.name,
            symbol: context.tick.symbol,
            side,
            reason: 'momentum reversal',
            price:
              side === 'buy'
                ? context.tick.price.takerBuyPrice
                : context.tick.price.takerSellPrice,
            exchangeTimestampMs: context.tick.exchangeTimestampMs,
            meta: {
              intervalMs: this.intervalMs,
              buyDeltaPercent: buyDelta?.percent ?? null,
              sellDeltaPercent: sellDelta?.percent ?? null,
              buyHigh: buyHighLow?.high ?? null,
              buyLow: buyHighLow?.low ?? null,
              sellHigh: sellHighLow?.high ?? null,
              sellLow: sellHighLow?.low ?? null,
            },
          };

    signalBus.setState(newState);
  }
}
