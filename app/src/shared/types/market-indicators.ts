// app/src/shared/types/market-indicators.ts
import type {
  INDICATOR_CODECS,
} from '../constants/market-indicators.js';

export type IndicatorValueCodecName =
  typeof INDICATOR_CODECS[number]['name'];

export type IndicatorValueCodecIndex = number;

export type MarketIndicators = Readonly<Record<string, number>>;

export type MarketIndicatorValues = Record<string, number | null>;

export interface MarketIndicatorStorageConfig {
  name: string;
  codecIndex: IndicatorValueCodecIndex;
}

export type MarketIndicatorsRegistry =
  readonly MarketIndicatorStorageConfig[];

export interface MarketIndicatorRecalculatedItem {
  startIndexAsc: number;
  values: (number | null)[];
}

export interface IndicatorResults {
  indicatorName: string;
  lastResult: number | null;
  recalculatedValues: MarketIndicatorRecalculatedItem[];
};

export interface IndicatorValuesChunk {
  indicatorName: string;
  level: number;
  offset: number;
  values: (number | null)[];
}

export interface ChangedIndicatorChunk extends IndicatorValuesChunk {
  startReceivedAt: number;
  endReceivedAt: number;
}
