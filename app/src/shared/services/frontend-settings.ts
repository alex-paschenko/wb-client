// app/src/shared/services/frontend-settings.ts
import {
  DEFAULT_CANDLE_COLOR,
  DEFAULT_INDICATOR_COLORS,
} from '../../shared/constants/frontend-settings';
import type {
  MarketIndicatorsRegistry,
} from '../types/market-indicators.js';
import type {
  MarketsByName,
} from '../types/market.js';
import {
  MARKET_VIEW_STATES,
  type CandleSettings,
  type FrontendSettingsValue,
  type IndicatorSettings,
  type IndicatorsSettings,
  type MarketViewState,
  type MarketViewStateItem,
  type OpenMarketViewState,
} from '../types/frontend-settings.js';

const getRandomIndicatorColor = (): string => {
  const index = Math.floor(
    Math.random() *
    DEFAULT_INDICATOR_COLORS.length,
  );

  return DEFAULT_INDICATOR_COLORS[index];
};

const cloneIndicatorSettings = (
  settings: IndicatorSettings,
): IndicatorSettings => ({
  ...settings,
});

const cloneIndicatorsSettings = (
  settings: IndicatorsSettings,
): IndicatorsSettings =>
  Object.fromEntries(
    Object.entries(settings).map(
      ([name, indicatorSettings]) => [
        name,
        cloneIndicatorSettings(
          indicatorSettings,
        ),
      ],
    ),
  );

export class FrontendSettings {
  public constructor(
    private readonly value: FrontendSettingsValue,
  ) {}

  public static createDefault(): FrontendSettings {
    return new FrontendSettings({
      language: 'en',
      theme: 'light',
      marketsViewStates: [],
      candles: {
        color: DEFAULT_CANDLE_COLOR,
      },
      indicators: {},
    });
  }

  public static fromValue(
    value: FrontendSettingsValue,
  ): FrontendSettings {
    /*
     * The fallbacks keep previously saved settings
     * compatible with the extended format.
     */
    return new FrontendSettings({
      language: value.language,
      theme: value.theme,

      marketsViewStates:
        value.marketsViewStates.map(
          (item) => ({
            ...item,
          }),
        ),

      candles: {
        color:
          value.candles?.color ??
          DEFAULT_CANDLE_COLOR,
      },

      indicators:
        cloneIndicatorsSettings(
          value.indicators ?? {},
        ),
    });
  }

  public toValue(): FrontendSettingsValue {
    return {
      language: this.value.language,
      theme: this.value.theme,

      marketsViewStates:
        this.value.marketsViewStates.map(
          (item) => ({
            ...item,
          }),
        ),

      candles: {
        ...this.value.candles,
      },

      indicators:
        cloneIndicatorsSettings(
          this.value.indicators,
        ),
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

  public getCandles(): CandleSettings {
    return {
      ...this.value.candles,
    };
  }

  public getCandleColor(): string {
    return this.value.candles.color;
  }

  public setCandleColor(color: string): void {
    this.value.candles.color = color;
  }

  public getIndicators(): IndicatorsSettings {
    return cloneIndicatorsSettings(
      this.value.indicators,
    );
  }

  public getIndicator(
    indicatorName: string,
  ): IndicatorSettings | null {
    const settings =
      this.value.indicators[
        indicatorName
      ];

    return settings
      ? cloneIndicatorSettings(settings)
      : null;
  }

  public setIndicatorColor(
    indicatorName: string,
    color: string,
  ): void {
    const settings =
      this.value.indicators[
        indicatorName
      ];

    if (!settings) {
      return;
    }

    settings.color = color;
  }

  public setIndicatorVisible(
    indicatorName: string,
    isVisible: boolean,
  ): void {
    const settings =
      this.value.indicators[
        indicatorName
      ];

    if (!settings) {
      return;
    }

    settings.isVisible = isVisible;
  }

  public ensureIndicators(
    registry: MarketIndicatorsRegistry,
  ): boolean {
    const indicatorNames = new Set(
      registry.map(
        (indicator) => indicator.name,
      ),
    );

    let hasChanges = false;

    for (const indicatorName of indicatorNames) {
      if (
        this.value.indicators[
          indicatorName
        ]
      ) {
        continue;
      }

      this.value.indicators[
        indicatorName
      ] = {
        color:
          getRandomIndicatorColor(),
        isVisible: true,
      };

      hasChanges = true;
    }

    for (
      const indicatorName
      of Object.keys(
        this.value.indicators,
      )
    ) {
      if (
        indicatorNames.has(
          indicatorName,
        )
      ) {
        continue;
      }

      delete this.value.indicators[
        indicatorName
      ];

      hasChanges = true;
    }

    return hasChanges;
  }

  public ensureMarkets(
    markets: MarketsByName,
  ): boolean {
    const knownMarkets = new Set(
      this.value.marketsViewStates.map(
        (item) => item.marketName,
      ),
    );

    let hasChanges = false;

    for (
      const marketName
      of Object.keys(markets)
    ) {
      if (
        !knownMarkets.has(
          marketName,
        )
      ) {
        this.value.marketsViewStates.push({
          marketName,
          state:
            MARKET_VIEW_STATES.closed,
        });

        hasChanges = true;
      }
    }

    return hasChanges;
  }

  public getMarketsViewStates():
    MarketViewStateItem[] {
    return this.value.marketsViewStates.map(
      (item) => ({
        ...item,
      }),
    );
  }

  public getOpenMarketsViewStates():
    MarketViewStateItem[] {
    return this.getMarketsViewStates()
      .filter(
        (item) =>
          item.state !==
          MARKET_VIEW_STATES.closed,
      );
  }

  public getClosedMarketsViewStates():
    MarketViewStateItem[] {
    return this.getMarketsViewStates()
      .filter(
        (item) =>
          item.state ===
          MARKET_VIEW_STATES.closed,
      );
  }

  public getOpenMarkets(): string[] {
    return this.getOpenMarketsViewStates()
      .map(
        (item) => item.marketName,
      );
  }

  public getMarketViewState(
    marketName: string,
  ): MarketViewState {
    return this.findMarketItem(
      marketName,
    )?.state ??
      MARKET_VIEW_STATES.closed;
  }

  public setMarketViewState(
    marketName: string,
    state: MarketViewState,
  ): void {
    const item =
      this.findMarketItem(
        marketName,
      );

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
    state: OpenMarketViewState =
      MARKET_VIEW_STATES.half,
  ): void {
    this.setMarketViewState(
      marketName,
      state,
    );
  }

  public closeMarket(
    marketName: string,
  ): void {
    this.setMarketViewState(
      marketName,
      MARKET_VIEW_STATES.closed,
    );
  }

  public isMarketOpen(
    marketName: string,
  ): boolean {
    return (
      this.getMarketViewState(
        marketName,
      ) !==
      MARKET_VIEW_STATES.closed
    );
  }

  public moveMarket(
    marketName: string,
    targetIndex: number,
  ): void {
    const currentIndex =
      this.value.marketsViewStates
        .findIndex(
          (item) =>
            item.marketName ===
            marketName,
        );

    if (currentIndex === -1) {
      return;
    }

    const [item] =
      this.value.marketsViewStates
        .splice(currentIndex, 1);

    const safeTargetIndex =
      Math.max(
        0,
        Math.min(
          targetIndex,
          this.value
            .marketsViewStates.length,
        ),
      );

    this.value.marketsViewStates
      .splice(
        safeTargetIndex,
        0,
        item,
      );
  }

  private findMarketItem(
    marketName: string,
  ): MarketViewStateItem | undefined {
    return this.value
      .marketsViewStates
      .find(
        (item) =>
          item.marketName ===
          marketName,
      );
  }
}
