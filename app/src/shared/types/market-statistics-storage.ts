export type MarketStatisticsSourceType =
  | 'snapshot'
  | 'candle';

export interface MarketStatisticsLevelConfig {
  sourceType: MarketStatisticsSourceType;
  duration: number;
  interval: number;
  chunkCapacity: number;
}

export interface MarketSnapshot {
  receivedAt: number;
  price: number;
  speed: number;
}

export interface MarketCandle extends MarketSnapshot {
  startedAt: number;
  endedAt: number;

  open: number;
  close: number;
  high: number;
  low: number;
}

export type MarketStatisticsItem =
  | MarketSnapshot
  | MarketCandle;

export type MarketStatisticsDeltaRecordMode =
  | 'should record delta'
  | 'suppress record delta';

export type MarketStatisticsItemsDirection =
  | 'direct'
  | 'reverse';

export interface MarketStatisticsItems {
  readonly marketName: string;
  readonly length: number;

  get(index: number): MarketSnapshot;
  candle(index: number): MarketCandle | null;
}

export interface MarketStatisticsChunk {
  data: Float64Array;
  start: number;
  end: number;
}

export interface MarketStatisticsLevel {
  chunks: MarketStatisticsChunk[];

  startedAt: number | null;
  endedAt: number | null;
}
