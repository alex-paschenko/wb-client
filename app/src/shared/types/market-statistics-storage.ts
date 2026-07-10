// app/src/shared/types/market-statistics-storage.ts
export interface MarketStatisticsLevelConfig {
  duration: number;
  interval: number;
  chunkCapacity: number;
}

export interface MarketCandle {
  receivedAt: number;
  price: number;
  speed: number;
  startedAt: number;
  endedAt: number;

  open: number;
  close: number;
  high: number;
  low: number;
}

export type MarketStatisticsDeltaRecordMode =
  | 'should record delta'
  | 'suppress record delta';

export type MarketCandlesDirection =
  | 'direct'
  | 'reverse';

import type {
  MarketIndicatorValues,
} from './market-indicators.js';

export interface MarketDataArray<T> {
  readonly length: number;
  readonly [index: number]: T | undefined;
}

export type MarketDataProjectionDirection =
  | 'ascending'
  | 'descending';

export interface MarketDataProjection {
  readonly candles: MarketDataArray<MarketCandle>;
  readonly indicators: MarketDataArray<MarketIndicatorValues>;
}

export interface MarketDataView {
  readonly marketName: string;
  readonly receivedAt: number;
  readonly ascending: MarketDataProjection;
  readonly descending: MarketDataProjection;
}

export interface ExtendedMarketDataView extends MarketDataView {
  centralIndexesAsc: number[];
  numOfAffectedLevels: number;
}

export interface MarketStatisticsChunk {
  data: Float64Array;
  start: number;
  end: number;
  size: number;
}

export interface MarketStatisticsLevel {
  chunks: MarketStatisticsChunk[];

  size: number;
  startedAt: number | null;
  endedAt: number | null;
}
