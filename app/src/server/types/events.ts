import type {
  MarketCandle,
  MarketSnapshot,
  MarketStatisticsItems,
  MarketStatisticsItemsDirection,
} from '../../shared/types/market-statistics-storage.js';
import type {
  MarketRollingStatistics,
  MarketRollingStatisticsByMarket,
} from '../../shared/types/market-statistics-rolling.js';
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
  item: MarketSnapshot | MarketCandle;
  deleteBefore: number;
}

export interface MarketStatisticsPersistenceChangedEvent {
  marketName: string;

  /**
   * Index is level.
   * changes[0] is always snapshot.
   * changes[1+] are candles.
   * No gaps.
   */
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

export interface MarketStatisticsViewUpdated {
  marketName: string;
  createItems:
    (direction: MarketStatisticsItemsDirection) =>
      MarketStatisticsItems

}

export interface MarketStatisticsRestoredMarketData {
  snapshots: MarketSnapshot[];
  candlesByLevel: MarketCandle[][];
}

export interface MarketStatisticsRestoredEvent {
  itemsByMarket: Record<string, MarketStatisticsRestoredMarketData>;
}

export interface MarketStatisticsApproximatedEvent {
  marketName: string;
  receivedAt: number;

  // TODO: Replace unknown[] with the final approximated strategy input type.
  items: unknown[];
}

export interface MarketStatisticsFullSyncReleasedEvent {
  marketName: string;
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

  [SERVER_EVENT.marketRollingTickReceived]: MarketRollingTickReceivedEvent;
  [SERVER_EVENT.marketRollingUpdated]: MarketRollingUpdatedEvent;
  [SERVER_EVENT.marketTickReceived]: MarketTickReceivedEvent;
  [SERVER_EVENT.marketStatisticsStorageChanged]: MarketStatisticsStorageChangedEvent;
  [SERVER_EVENT.marketStatisticsViewUpdated]: MarketStatisticsViewUpdated;
  [SERVER_EVENT.marketStatisticsRestored]: MarketStatisticsRestoredEvent;
  [SERVER_EVENT.marketStatisticsPersistenceChanged]: MarketStatisticsPersistenceChangedEvent;
  [SERVER_EVENT.marketStatisticsApproximated]: MarketStatisticsApproximatedEvent;

  [SERVER_EVENT.marketStatisticsFullSyncReleased]: MarketStatisticsFullSyncReleasedEvent;

  [SERVER_EVENT.strategySignalCreated]: StrategySignalCreatedEvent;
  [SERVER_EVENT.strategyFailed]: StrategyFailedEvent;
}
