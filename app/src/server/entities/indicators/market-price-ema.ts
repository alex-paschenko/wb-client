import type { MarketCandle } from '../../../shared/types/data-types.js';
import { RecursiveFilterIndicator } from './recursive-filter-indicator.js';

export type MarketPriceEmaInput = 'log-price' | 'price';

export function marketPriceEmaName(input: MarketPriceEmaInput, tau: number): string {
  return `market-${input}-ema-${tau}`;
}

// The v6 research bank uses 1000 * ln(price) and Float64 EMA state.
export class MarketPriceEmaIndicator extends RecursiveFilterIndicator {
  public constructor(
    tau: number,
    private readonly input: MarketPriceEmaInput,
  ) {
    super(tau, marketPriceEmaName(input, tau), 'float64 (nullable) v1.0', []);
  }

  protected getInput(candle: MarketCandle): number | null {
    if (!Number.isFinite(candle.price) || candle.price <= 0) return null;
    return this.input === 'price'
      ? candle.price
      : 1000 * Math.log(candle.price);
  }
}
