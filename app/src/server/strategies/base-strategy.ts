import { isDeepStrictEqual } from 'node:util';

import { globalStateService } from '../../shared/services/global-state.js';
import type { MarketType } from '../../shared/types/market.js';
import { strategyIdleState } from '../constants/strategies.js';
import { OrderAndStrategy } from '../types/orders.js';
import type {
  Strategy,
  StrategyStates,
  StrategyRunParams,
  StrategyRests,
} from '../types/strategies.js';

export abstract class BaseStrategy<T extends string>
  implements Strategy<T> {
  private strategyName: string;

  protected rests: Map<string, StrategyRests> = new Map();

  constructor(name: string) {
    this.strategyName = name;
  }

  public run(params: StrategyRunParams<T>): void {
    const receivedAt = params.storage[params.storage.length - 1].receivedAt;

    if (params.stateChanges.length === 0) {
      params.stateChanges.push({
        kind: 'bare',
        receivedAt,
        state: strategyIdleState,
      });
    }

    let currentStatus: StrategyStates<T>;

    do {
      const prevStatus = params.stateChanges.at(-1);

      currentStatus = this.exec(params);

      if (
        currentStatus.action === 'continue' &&
        currentStatus.state === prevStatus?.state
      ) {
        throw new Error(
          `${this.name}: continue without a state change (${prevStatus})`,
        );
      }

      if (!isDeepStrictEqual(prevStatus, currentStatus)) {
        params.stateChanges.push({
          ...currentStatus,
          receivedAt,
        });
      }
    } while (currentStatus.action !== 'stop');
  }

  public get name(): string {
    return this.strategyName;
  }

  protected abstract exec(
    params: StrategyRunParams<T>,
  ): StrategyStates<T>;

  protected isMarketRestricted(
    marketName: string,
    marketType?: MarketType,
  ): boolean {
    const market = globalStateService.getMarkets()[marketName];
    if (!market) {
      throw new Error(`Market "${marketName}" not found.`);
    }

    return !(
      market.isActive &&
      market.tradesEnabled &&
      (!marketType || market.type === marketType)
    );
  }

  protected isOrderCommandCompleted(
    orderEntry?: OrderAndStrategy,
  ): orderEntry is OrderAndStrategy {
    return !!orderEntry && orderEntry.error !== undefined;
  }

  protected getRests(marketName: string): StrategyRests {
    const dealAmount = this.rests.get(marketName);
    if (!dealAmount) {
      throw new Error(`Missing deal amount for "${marketName}" market.`);
    }

    return dealAmount;
  }
}
