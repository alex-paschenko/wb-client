// app/src/shared/types/market-statistic-accessors.ts

import type { MarketIndicatorValues } from './market-indicators.js';

export interface MarketCandleIndicatorsChange {
  marketName: string;
  level: number;
  startedAt: number;
  endedAt: number;
  indicators: MarketIndicatorValues;
}

export interface ChangedIndicatorInterval {
  level: number;
  chunkIndex: number;
  itemIndex: number;
  itemCount: number;
}

export type ChangedIndicatorIntervalsByName =
  Map<string, ChangedIndicatorInterval[]>;
