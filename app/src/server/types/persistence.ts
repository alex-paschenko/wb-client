// app/src/server/types/persistence.ts

import type {
  MarketIndicatorValues
} from '../../shared/types/market-indicators';
import type {
  MarketCandle
} from '../../shared/types/market-statistics-storage';

export interface MarketCandleAddRow extends MarketCandle {
  marketName: string;
  level: number;
}

export interface MarketCandleRemoveRow {
  marketName: string;
  level: number;
  timeThreshold: number;
}

export interface MarketCandleIndicatorsChange {
  marketName: string;
  level: number;
  startedAt: number;
  endedAt: number;
  indicators: MarketIndicatorValues;
}

export interface MarketStatisticsPersistenceChanges {
  newCandles: MarketCandleAddRow[];
  deleteBefore: MarketCandleRemoveRow[];
  indicatorChanged: MarketCandleIndicatorsChange[];
}
