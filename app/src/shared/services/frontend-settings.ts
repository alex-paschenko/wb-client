import type {
  MarketsByName,
} from '../types/market.js';
import {
  MARKET_VIEW_STATES,
  type FrontendSettingsValue,
  type MarketViewState,
  type MarketViewStateItem,
  type OpenMarketViewState,
} from '../types/frontend-settings.js';

export class FrontendSettings {
  public constructor(
    private readonly value: FrontendSettingsValue,
  ) {}

  public static createDefault(): FrontendSettings {
    return new FrontendSettings({
      language: 'en',
      theme: 'light',
      marketsViewStates: [],
    });
  }

  public static fromValue(value: FrontendSettingsValue): FrontendSettings {
    return new FrontendSettings({
      language: value.language,
      theme: value.theme,
      marketsViewStates: value.marketsViewStates.map((item) => ({ ...item })),
    });
  }

  public toValue(): FrontendSettingsValue {
    return {
      language: this.value.language,
      theme: this.value.theme,
      marketsViewStates: this.value.marketsViewStates.map((item) => ({ ...item })),
    };
  }

  public getLanguage(): string {
    return this.value.language;
  }

  public setLanguage(language: string): void {
    this.value.language = language;
  }

  public getTheme(): string {
    return this.value.theme;
  }

  public setTheme(theme: string): void {
    this.value.theme = theme;
  }

  public ensureMarkets(markets: MarketsByName): boolean {
    const knownMarkets = new Set(
      this.value.marketsViewStates.map((item) => item.marketName),
    );

    let hasChanges = false;

    for (const marketName of Object.keys(markets)) {
      if (!knownMarkets.has(marketName)) {
        this.value.marketsViewStates.push({
          marketName,
          state: MARKET_VIEW_STATES.closed,
        });

        hasChanges = true;
      }
    }

    return hasChanges;
  }

  public getMarketsViewStates(): MarketViewStateItem[] {
    return this.value.marketsViewStates.map((item) => ({ ...item }));
  }

  public getOpenMarketsViewStates(): MarketViewStateItem[] {
    return this.getMarketsViewStates()
      .filter((item) => item.state !== MARKET_VIEW_STATES.closed);
  }

  public getClosedMarketsViewStates(): MarketViewStateItem[] {
    return this.getMarketsViewStates()
      .filter((item) => item.state === MARKET_VIEW_STATES.closed);
  }

  public getOpenMarkets(): string[] {
    return this.getOpenMarketsViewStates()
      .map((item) => item.marketName);
  }

  public getMarketViewState(marketName: string): MarketViewState {
    return this.findMarketItem(marketName)?.state ??
      MARKET_VIEW_STATES.closed;
  }

  public setMarketViewState(
    marketName: string,
    state: MarketViewState,
  ): void {
    const item = this.findMarketItem(marketName);

    if (item) {
      item.state = state;
      return;
    }

    this.value.marketsViewStates.push({
      marketName,
      state,
    });
  }

  public openMarket(
    marketName: string,
    state: OpenMarketViewState = MARKET_VIEW_STATES.half,
  ): void {
    this.setMarketViewState(marketName, state);
  }

  public closeMarket(marketName: string): void {
    this.setMarketViewState(marketName, MARKET_VIEW_STATES.closed);
  }

  public isMarketOpen(marketName: string): boolean {
    return this.getMarketViewState(marketName) !== MARKET_VIEW_STATES.closed;
  }

  public moveMarket(
    marketName: string,
    targetIndex: number,
  ): void {
    const currentIndex = this.value.marketsViewStates.findIndex(
      (item) => item.marketName === marketName,
    );

    if (currentIndex === -1) {
      return;
    }

    const [item] = this.value.marketsViewStates.splice(currentIndex, 1);

    const safeTargetIndex = Math.max(
      0,
      Math.min(targetIndex, this.value.marketsViewStates.length),
    );

    this.value.marketsViewStates.splice(safeTargetIndex, 0, item);
  }

  private findMarketItem(
    marketName: string,
  ): MarketViewStateItem | undefined {
    return this.value.marketsViewStates.find(
      (item) => item.marketName === marketName,
    );
  }
}
