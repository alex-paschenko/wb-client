// app/src/server/strategies/one-market-two-deals.ts

import type {
  OneMarketTwoDealsStrategyState,
  Strategy,
  StrategyDirection,
  StrategyStates,
  StrategyRunParams,
} from '../types/strategies.js';
import { BaseStrategy } from './base-strategy.js';

interface OneMarketTwoDealsParams {
  candidateTreshold: number;
}

export class OneMarketTwoDeals extends BaseStrategy<OneMarketTwoDealsStrategyState> {
  private params: OneMarketTwoDealsParams;

  private direction: StrategyDirection | null = null;

  public constructor(params: OneMarketTwoDealsParams) {
    const name = 'm1d2:' + Object.values(params).join('-');
    super(name);

    this.params = params;
  }

  exec(
    params: StrategyRunParams<OneMarketTwoDealsStrategyState>,
  ): StrategyStates<OneMarketTwoDealsStrategyState> {
    const { storage, depthApi, stateChanges } = params;

    const lastStorage = storage[storage.length - 1];
    const { forecast, receivedAt, marketName } = lastStorage;

    const state = stateChanges.at(-1)?.state;

    const expectedCombined = forecast.expectedResidual1mCombined;

    switch(state) {
      case 'idle':
        if (
          expectedCombined &&
          Math.abs(expectedCombined) > this.params.candidateTreshold
        ) {
          this.direction = expectedCombined > 0 ? 'long' : 'short';

          const subscribed = depthApi.orderBookDepthSubscription({
            subscription: { marketName, action: 'subscribe' },
            strategy: this as Strategy<string>,
            receivedAt,
          });

          if (subscribed) {
            return { state: 'candidate', action: 'continue' };
          }
        }

        return { state, action: 'stop' };

      case 'candidate':
        return { state, action: 'stop' };
      default:
        return { state: state ?? 'idle', action: 'stop' };
    }
  }
}
