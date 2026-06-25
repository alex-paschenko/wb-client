import type { MarketDataStore, RuntimeTick } from '../services/market-data-store.js';

export interface StrategyTickContext {
  tick: RuntimeTick;
  store: MarketDataStore;
}

export interface TradingStrategy {
  name: string;

  onTick(context: StrategyTickContext): Promise<void>;
}
