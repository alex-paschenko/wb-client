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

export interface MarketCandles {
  readonly marketName: string;
  readonly length: number;
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
