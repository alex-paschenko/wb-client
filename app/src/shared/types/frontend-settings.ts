// app/src/shared/types/frontend-settings.ts
export const MARKET_VIEW_STATES = {
  closed: 'closed',
  quarter: 'quarter',
  half: 'half',
  full: 'full',
} as const;

export type MarketViewState =
  (typeof MARKET_VIEW_STATES)[keyof typeof MARKET_VIEW_STATES];

export type OpenMarketViewState =
  Exclude<MarketViewState, 'closed'>;

export type MarketViewStateItem = {
  marketName: string;
  state: MarketViewState;
};

export type CandleSettings = {
  color: string;
};

export type IndicatorSettings = {
  color: string;
  isVisible: boolean;
};

export type IndicatorsSettings =
  Record<string, IndicatorSettings>;

export type FrontendSettingsValue = {
  language: string;
  theme: string;
  marketsViewStates: MarketViewStateItem[];
  candles: CandleSettings;
  indicators: IndicatorsSettings;
};

export const isMarketViewState = (
  value: unknown,
): value is MarketViewState => {
  return Object.values(MARKET_VIEW_STATES)
    .includes(value as MarketViewState);
};
