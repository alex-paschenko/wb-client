// app/src/server/types/events.ts
import type {
  MarketCandle,
  MarketCandles,
  MarketCandlesDirection,
} from '../../shared/types/market-statistics-storage.js';
import type {
  MarketRollingStatistics,
  MarketRollingStatisticsByMarket,
} from '../../shared/types/market-statistics-rolling.js';
import type {
  MarketIndicators,
} from '../../shared/types/market-indicators.js';
import type { StrategySignal } from './strategy-signals.js';
import type { SERVER_EVENT } from '../constants/events.js';
import { MarketTick } from './market-statistics.js';

export type ServerEventName =
  typeof SERVER_EVENT[keyof typeof SERVER_EVENT];

export interface MarketsInfoUpdatedEvent {
  marketNames: string[];
}

export interface MarketRollingTickReceivedEvent {
  marketName: string;
  rollingStatistics: MarketRollingStatistics;
}

export interface MarketRollingUpdatedEvent {
  rollingStatisticsByMarket: MarketRollingStatisticsByMarket;
}

export interface MarketStatisticsPersistenceChange {
  item: MarketCandle;
  deleteBefore: number;
}

export interface MarketStatisticsPersistenceChangedEvent {
  marketName: string;
  changes: MarketStatisticsPersistenceChange[];
}

export interface MarketTickReceivedEvent {
  marketName: string;
  tick: MarketTick;
}

export interface MarketStatisticsStorageChangedEvent {
  marketName: string;
  delta: ArrayBuffer;
}

export interface MarketStatisticsStorageUpdatedEvent {
  marketName: string;
  candles: MarketCandles;
  reversedCandles: MarketCandles;
}

export type MarketStatisticsRestoredMarketData =
  Record<string, MarketCandle[][]>;

export interface MarketStatisticsRestoredEvent {
  itemsByMarket: MarketStatisticsRestoredMarketData;
}

export interface MarketStatisticsApproximatedEvent {
  marketName: string;
  receivedAt: number;

  // TODO: Replace unknown[] with the final approximated strategy input type.
  items: unknown[];
}

export interface FreezeOnStatisticsStorageNeedsToBeLoweredEvent {
  marketName: string;
}

export interface MarketRemovedEvent {
  marketName: string;
}

export interface MarketIndicatorsUpdatedEvent {
  marketName: string;
  indicators: MarketIndicators;
}

export interface StrategySignalCreatedEvent {
  marketName: string;
  strategyKey: string;
  receivedAt: number;
  decisionAt: number;
  signal: StrategySignal;
}

export interface StrategyFailedEvent {
  marketName: string;
  strategyKey: string;
  receivedAt: number;
  error: unknown;
}

export interface ServerEventMap {
  [SERVER_EVENT.marketsInfoUpdated]: MarketsInfoUpdatedEvent;

  [SERVER_EVENT.marketRemoved]: MarketRemovedEvent;

  [SERVER_EVENT.marketRollingTickReceived]: MarketRollingTickReceivedEvent;
  [SERVER_EVENT.marketRollingUpdated]: MarketRollingUpdatedEvent;

  [SERVER_EVENT.marketTickReceived]: MarketTickReceivedEvent;

  [SERVER_EVENT.marketStatisticsStorageChanged]:
    MarketStatisticsStorageChangedEvent;

  [SERVER_EVENT.marketStatisticsStorageUpdated]:
    MarketStatisticsStorageUpdatedEvent;

  [SERVER_EVENT.marketStatisticsRestored]:
    MarketStatisticsRestoredEvent;

  [SERVER_EVENT.marketStatisticsPersistenceChanged]:
    MarketStatisticsPersistenceChangedEvent;

  [SERVER_EVENT.marketStatisticsApproximated]:
    MarketStatisticsApproximatedEvent;

  [SERVER_EVENT.marketIndicatorsUpdated]: MarketIndicatorsUpdatedEvent;

  [SERVER_EVENT.freezeOnStatisticsStorageNeedsToBeLowered]:
    FreezeOnStatisticsStorageNeedsToBeLoweredEvent;

  [SERVER_EVENT.strategySignalCreated]: StrategySignalCreatedEvent;
  [SERVER_EVENT.strategyFailed]: StrategyFailedEvent;
}
