// app/src/server/indicators/base-indicator.ts
import type {
  MarketIndicator,
  MarketIndicatorCalculationParams,
} from '../types/market-indicators.js';

export abstract class BaseIndicator<TState = never>
  implements MarketIndicator {
  public abstract readonly name: string;

  public readonly dependencies: readonly string[] = [];

  protected readonly stateByMarket = new Map<string, TState>();

  public abstract calculate(
    params: MarketIndicatorCalculationParams,
  ): number | null;

  public removeMarket(marketName: string): void {
    this.stateByMarket.delete(marketName);
  }
}
