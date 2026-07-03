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

export interface MarketCandles {
  readonly marketName: string;
  readonly length: number;
  readonly [index: number]: MarketCandle | undefined;

  candle(index: number): MarketCandle | null;
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
