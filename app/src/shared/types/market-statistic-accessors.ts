// app/src/shared/types/market-statistic-accessors.ts

import type { MarketIndicatorValues } from './market-indicators.js';

export interface ChangedIndicatorInterval {
  level: number;
  chunkIndex: number;
  itemIndex: number;
  itemCount: number;
}

export type ChangedIndicatorIntervalsByName =
  Map<string, ChangedIndicatorInterval[]>;
