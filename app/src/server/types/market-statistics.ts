import { MarketSnapshot } from "../../shared/types/market-statistics-storage";

export const MARKET_STATISTICS_LEVEL_KEYS = [
    'snapshot',
    'candleLvl1',
    'candleLvl2',
    'candleLvl3',
] as const;

export type MarketStatisticsLevelKey =
    typeof MARKET_STATISTICS_LEVEL_KEYS[number];

export type MarketStatisticsSourceType =
    | 'snapshot'
    | 'candle';

export interface MarketStatisticsLevelConfig {
    level: number;
    key: MarketStatisticsLevelKey;
    sourceType: MarketStatisticsSourceType;

    duration: number;
    interval: number;
    chunkCapacity: number;
}

export const MARKET_SNAPSHOT_FIELDS = [
    'receivedAt',
    'price',
] as const;

export type MarketSnapshotField =
    typeof MARKET_SNAPSHOT_FIELDS[number];

export const MARKET_SNAPSHOT_FIELD_INDEX = {
    receivedAt: 0,
    price: 1,
} as const satisfies Record<MarketSnapshotField, number>;

export const MARKET_SNAPSHOT_FIELDS_PER_ITEM =
    MARKET_SNAPSHOT_FIELDS.length;

export type MarketTick = Omit<MarketSnapshot, 'speed'>;

export const MARKET_CANDLE_FIELDS = [
    'startedAt',
    'endedAt',
    'timestampMs',
    'open',
    'close',
    'high',
    'low',
] as const;

export type MarketCandleField =
    typeof MARKET_CANDLE_FIELDS[number];

export const MARKET_CANDLE_FIELD_INDEX = {
    startedAt: 0,
    endedAt: 1,
    timestampMs: 2,
    open: 3,
    close: 4,
    high: 5,
    low: 6,
} as const satisfies Record<MarketCandleField, number>;

export const MARKET_CANDLE_FIELDS_PER_ITEM =
    MARKET_CANDLE_FIELDS.length;

export interface MarketCandle {
    startedAt: number;
    endedAt: number;
    timestampMs: number;

    open: number;
    close: number;
    high: number;
    low: number;
}

export interface MarketStatisticsChunk {
    data: Float64Array;

    // Valid items are stored in [start, end).
    start: number;
    end: number;
}

export interface MarketStatisticsLevel {
    chunks: MarketStatisticsChunk[];

    startedAt: number | null;
    endedAt: number | null;
}

export type MarketStatisticsLevels = Record<
    MarketStatisticsLevelKey,
    MarketStatisticsLevel
>;

export interface MarketStatisticsStorageItem {
    marketName: string;
    levels: MarketStatisticsLevels;
}

export type MarketStatisticsStorage = Record<
    string,
    MarketStatisticsStorageItem
>;

export interface MarketRollingStatistics {
    receivedAt: number;

    last: number;
    open: number;
    close: number;
    high: number;
    low: number;

    stockVolume: number;
    moneyVolume: number;
}

export type MarketRollingStatisticsByMarket = Record<
    string,
    MarketRollingStatistics
>;
