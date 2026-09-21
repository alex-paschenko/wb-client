// app/src/shared/types/frontend-settings.ts

import type { StorageStructure } from './storage.js';

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

export type EntityDataSettings = Record<string, unknown>;

/*
 * Deep=1 keeps the outer StorageStructure readonly while entity maps
 * remain mutable inside FrontendSettings.
 */
export type EntitiesSettings =
  StorageStructure<EntityDataSettings, 1>;

export type FrontendSettingsValue = {
  language: string;
  theme: string;
  marketsViewStates: MarketViewStateItem[];
  entities: EntitiesSettings;
};

export const isMarketViewState = (
  value: unknown,
): value is MarketViewState => {
  return Object.values(MARKET_VIEW_STATES)
    .includes(value as MarketViewState);
};
