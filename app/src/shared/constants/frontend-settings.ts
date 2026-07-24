// app/src/shared/constants/frontend-settings.ts
import { defaultTheme } from './themes.js';
import { defaultLanguage } from '../i18n/languages.js';

import type {
  FrontendSettingsValue
} from '../types/frontend-settings.js';


export const DEFAULT_CANDLE_COLOR =
  '#2962ff';

export const DEFAULT_INDICATOR_COLORS = [
  '#f59e0b',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899',
  '#22c55e',
  '#f97316',
  '#6366f1',
  '#14b8a6',
  '#eab308',
  '#ef4444',
] as const;

export const defaultFrontendSettings: FrontendSettingsValue = {
  theme: defaultTheme,
  language: defaultLanguage,
  marketsViewStates: [],
  candles: { color: DEFAULT_CANDLE_COLOR },
  indicators: {},
};

export const getRandomIndicatorColor =
  (): string => {
    const index = Math.floor(
      Math.random() *
      DEFAULT_INDICATOR_COLORS.length,
    );

    return DEFAULT_INDICATOR_COLORS[index];
  };
