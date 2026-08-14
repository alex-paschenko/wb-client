// app/src/shared/types/market-indicators.ts

import type {
  INDICATOR_CODECS,
} from '../constants/market-indicators.js';

export type IndicatorValueCodecName =
  typeof INDICATOR_CODECS[number]['name'];

export type IndicatorValueCodecIndex = number;

export type MarketIndicators = Readonly<Record<string, number>>;

export type IndicatorValue = number | null;

export type MarketIndicatorValues = Record<string, IndicatorValue>;

export interface MarketIndicatorStorageConfig {
  name: string;
  codecIndex: IndicatorValueCodecIndex;
  group: string;
  requiresRemovedValues: boolean;
}

export type MarketIndicatorsRegistry =
  readonly MarketIndicatorStorageConfig[];
