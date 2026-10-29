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
        receivedAt,
        state: strategyIdleState,
      });
    }

    let currentStatusWithAction: StrategyStates<T>;

    do {
      const { receivedAt, ...prevStatus } =
        params.stateChanges[params.stateChanges.length - 1];
      currentStatusWithAction = this.exec(params);
      const { action, ...currentStatus } = currentStatusWithAction;

      if (
        action === 'continue' &&
        currentStatus.state === prevStatus?.state
      ) {
        throw new Error(
          `${this.name}: continue without a state change (${prevStatus})`,
        );
      }

      if (!isDeepStrictEqual(currentStatus, prevStatus)) {
        params.stateChanges.push({
          ...currentStatus,
          receivedAt,
        });
      }
    } while (currentStatusWithAction.action !== 'stop');
  }

  public get name(): string {
    return this.strategyName;
  }

  protected abstract exec(
    params: StrategyRunParams<T>,
  ): StrategyStates<T>;

  protected normalizedAmount(
    amount: number,
    marketName: string,
    currency: 'stock' | 'money',
  ): number {
    if (!Number.isFinite(amount) || amount <= 0) {
      return 0;
    }

    const market = globalStateService.getMarkets()[marketName];
    if (!market) {
      throw new Error(`Market "${marketName}" not found.`);
    }

    const precision = currency === 'stock'
      ? market.stockPrec
      : market.moneyPrec;

    const stepSize = currency === 'stock'
      ? market.stepSize ?? 10 ** -precision
      : 10 ** -precision;

    if (!Number.isFinite(stepSize) || stepSize <= 0) {
      throw new Error(`Invalid stepSize for market "${marketName}".`);
    }

    const limitedAmount = currency === 'money' && market.maxTotal > 0
      ? Math.min(amount, market.maxTotal)
      : amount;

    const ratio = limitedAmount / stepSize;
    const normalized = Math.floor(
      ratio * (1 + 2 * Number.EPSILON)
    ) * stepSize;

    const result = Number(normalized.toFixed(Math.max(0, precision)));

    if (currency === 'stock') {
      return result >= market.minAmount ? result : 0;
    }

    return result >= market.minTotal ? result : 0;
  }

  protected isMarketRestricted(
    marketName: string,
    marketType: MarketType | null = null,
    currencies: string[] = [],
  ): boolean {
    const market = globalStateService.getMarkets()[marketName];
    if (!market) {
      throw new Error(`Market "${marketName}" not found.`);
    }

    return !(
      market.isActive &&
      market.tradesEnabled &&
      (!marketType || market.type === marketType) &&
      currencies.some((c) => c === market.stock || c === market.money)
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
