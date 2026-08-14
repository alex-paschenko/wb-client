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
  acceleration: number;

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
  IndicatorValue,
  MarketIndicatorValues,
} from './market-indicators.js';

export interface MarketDataArray<T> {
  readonly length: number;
  [index: number]: T;
}

export type MarketDataProjectionDirection =
  | 'ascending'
  | 'descending';


export type IndicatorProjection =
  Record<string, MarketDataArray<IndicatorValue>>;

export interface MarketDataProjection {
  readonly candles: MarketDataArray<MarketCandle>;
  readonly indicators: IndicatorProjection;
}

export interface MarketDataProjectionSnapshot {
  candles: MarketCandle[];
  indicators: MarketIndicatorValues[];
}

export interface MarketDataView {
  readonly marketName: string;
  readonly receivedAt: number;
  readonly ascending: MarketDataProjection;
  readonly descending: MarketDataProjection;
}

export type AggregatedIndicators = Record<string, IndicatorValue[]>;

export interface AggregatedItemDescriptor {
  indexAsc: number;
  removedCandles: MarketCandle[];
  removedIndicators: AggregatedIndicators;
}

export interface ExtendedMarketDataView extends MarketDataView {
  aggregatedItemDescriptors: AggregatedItemDescriptor[];
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

export interface FullMarketStatisticsLevel {
  candles: MarketCandle[];
  indicators: MarketIndicatorValues[];
}

export interface CandleIndicatorsChange {
  level: number;
  startedAt: number;
  endedAt: number;
  indicators: MarketIndicatorValues;
}

export interface ResolvedIndex {
  level: number;
  levelOffset: number;
  chunk: MarketStatisticsChunk;
  chunkIndex: number;
  itemIndex: number;
}
