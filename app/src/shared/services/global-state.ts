// app/src/shared/services/global-state.ts

import type {
  MarketIndicatorsRegistry,
} from '../types/market-indicators.js';
import type { MarketsByName } from '../types/market.js';

type IndicatorRegistryListener = (
  registry: MarketIndicatorsRegistry | null,
) => void;

type MarketsListener = (
  markets: MarketsByName | null,
  marketNames: readonly string[] | null,
) => void;

export class GlobalStateService {
  private indicatorRegistry:
    MarketIndicatorsRegistry | null = null;

  private indicatorRegistryPromise:
    Promise<MarketIndicatorsRegistry> | null = null;

  private resolveIndicatorRegistry:
    ((registry: MarketIndicatorsRegistry) => void) | null = null;

  private readonly indicatorRegistryListeners =
    new Set<IndicatorRegistryListener>();

  private marketsByName: MarketsByName | null = null;

  private marketNames: string[] | null = null;

  private marketsPromise:
    Promise<MarketsByName> | null = null;

  private resolveMarkets:
    ((markets: MarketsByName) => void) | null = null;

  private readonly marketsListeners = new Set<MarketsListener>();

  public setIndicatorRegistry(
    registry: MarketIndicatorsRegistry,
  ): void {
    const storedRegistry = Object.freeze(
      registry.map((entry) =>
        Object.freeze({
          ...entry,
        }),
      ),
    );

    this.indicatorRegistry = storedRegistry;

    this.resolveIndicatorRegistry?.(storedRegistry);

    this.resolveIndicatorRegistry = null;
    this.indicatorRegistryPromise = null;

    this.notifyIndicatorRegistryListeners();
  }

  public getIndicatorRegistry(): MarketIndicatorsRegistry {
    if (!this.indicatorRegistry) {
      throw new Error(
        'Market indicators registry is not initialized',
      );
    }

    return this.indicatorRegistry;
  }

  public getIndicatorRegistryOrNull():
    MarketIndicatorsRegistry | null {
    return this.indicatorRegistry;
  }

  public hasIndicatorRegistry(): boolean {
    return this.indicatorRegistry !== null;
  }

  public waitForIndicatorRegistry():
    Promise<MarketIndicatorsRegistry> {
    if (this.indicatorRegistry) {
      return Promise.resolve(this.indicatorRegistry);
    }

    if (!this.indicatorRegistryPromise) {
      this.indicatorRegistryPromise = new Promise((resolve) => {
        this.resolveIndicatorRegistry = resolve;
      });
    }

    return this.indicatorRegistryPromise;
  }

  public subscribeIndicatorRegistry(
    listener: IndicatorRegistryListener,
  ): () => void {
    this.indicatorRegistryListeners.add(listener);
    listener(this.getIndicatorRegistryOrNull());

    return () => {
      this.indicatorRegistryListeners.delete(listener);
    };
  }

  public clearIndicatorRegistry(): void {
    this.indicatorRegistry = null;
    this.indicatorRegistryPromise = null;
    this.resolveIndicatorRegistry = null;

    this.notifyIndicatorRegistryListeners();
  }

  public setMarkets(
    markets: MarketsByName,
    marketNames: readonly string[],
  ): void {
    const storedMarkets = structuredClone(markets);
    const storedMarketNames = [...marketNames];

    this.marketsByName = storedMarkets;
    this.marketNames = storedMarketNames;

    this.resolveMarkets?.(storedMarkets);

    this.resolveMarkets = null;
    this.marketsPromise = null;

    this.notifyMarketsListeners();
  }

  public getMarkets(): MarketsByName {
    if (!this.marketsByName) {
      throw new Error(
        'Markets are not initialized',
      );
    }

    return structuredClone(this.marketsByName);
  }

  public getMarketsOrNull(): MarketsByName | null {
    return this.marketsByName
      ? structuredClone(this.marketsByName)
      : null;
  }

  public getMarketNames(): string[] | null {
    return this.marketNames
      ? [...this.marketNames]
      : null;
  }

  public hasMarkets(): boolean {
    return this.marketsByName !== null;
  }

  public waitForMarkets(): Promise<MarketsByName> {
    if (this.marketsByName) {
      return Promise.resolve(
        structuredClone(this.marketsByName),
      );
    }

    if (!this.marketsPromise) {
      this.marketsPromise = new Promise((resolve) => {
        this.resolveMarkets = resolve;
      });
    }

    return this.marketsPromise;
  }

  public subscribeMarkets(
    listener: MarketsListener,
  ): () => void {
    this.marketsListeners.add(listener);

    listener(
      this.getMarketsOrNull(),
      this.getMarketNames(),
    );

    return () => {
      this.marketsListeners.delete(listener);
    };
  }

  public clearMarkets(): void {
    this.marketsByName = null;
    this.marketNames = null;

    this.marketsPromise = null;
    this.resolveMarkets = null;

    this.notifyMarketsListeners();
  }

  private notifyIndicatorRegistryListeners(): void {
    for (const listener of this.indicatorRegistryListeners) {
      listener(this.getIndicatorRegistryOrNull());
    }
  }

  private notifyMarketsListeners(): void {
    for (const listener of this.marketsListeners) {
      listener(
        this.getMarketsOrNull(),
        this.getMarketNames(),
      );
    }
  }
}

export const globalStateService =
  new GlobalStateService();
