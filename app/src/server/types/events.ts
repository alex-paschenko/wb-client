// app/src/server/types/events.ts

import type {
  ExtendedMarketDataView,
  FullMarketStatisticsLevel,
  MarketCandle,
} from '../../shared/types/market-statistics-storage.js';
import type {
  MarketRollingStatistics,
  MarketRollingStatisticsByMarket,
} from '../../shared/types/market-statistics-rolling.js';
import type {
  MarketIndicatorsRegistry,
} from '../../shared/types/market-indicators.js';
import type { StrategySignal } from './strategy-signals.js';
import type { SERVER_EVENT } from '../constants/events.js';
import type { MarketTick } from './market-statistics.js';
import type { MarketsByName } from '../../shared/types/market.js';
import type {
  MarketCandleAddRow,
  MarketCandleIndicatorsChange,
  MarketCandleRemoveRow,
  MarketStatisticsPersistenceChanges,
} from './persistence.js';

export type ServerEventName =
  typeof SERVER_EVENT[keyof typeof SERVER_EVENT];

export interface MarketsInfoUpdatedEvent {
  markets: MarketsByName;
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

export interface MarketTickReceivedEvent {
  marketName: string;
  tick: MarketTick;
}

export interface MarketStatisticsStorageChangedEvent {
  marketName: string;
  delta: ArrayBuffer;
}

export interface MarketStatisticsIndicatorsChangedEvent {
  marketName: string;
  changes: ArrayBuffer;
}

export type RecalculateIndicatorsRequestEvent = ExtendedMarketDataView;

export interface IndicatorsRecalculatedEvent {
  marketName: string;
  receivedAt: number;
}

export interface MarketIndicatorsRegistryReadyEvent {
  registry: MarketIndicatorsRegistry;
}

export type MarketStatisticsRestoredMarketData =
  Record<string, FullMarketStatisticsLevel[]>;

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
  [SERVER_EVENT.marketStatisticsIndicatorsChanged]:
    MarketStatisticsIndicatorsChangedEvent;

  [SERVER_EVENT.marketIndicatorsRegistryReady]:
    MarketIndicatorsRegistryReadyEvent;
  [SERVER_EVENT.recalculateIndicatorsRequest]:
    RecalculateIndicatorsRequestEvent;
  [SERVER_EVENT.indicatorsRecalculated]:
    IndicatorsRecalculatedEvent;

  [SERVER_EVENT.marketStatisticsRestored]:
    MarketStatisticsRestoredEvent;

  [SERVER_EVENT.marketStatisticsPersistenceChanged]:
    MarketStatisticsPersistenceChanges;

  [SERVER_EVENT.marketStatisticsApproximated]:
    MarketStatisticsApproximatedEvent;

  [SERVER_EVENT.freezeOnStatisticsStorageNeedsToBeLowered]:
    FreezeOnStatisticsStorageNeedsToBeLoweredEvent;

  [SERVER_EVENT.strategySignalCreated]: StrategySignalCreatedEvent;
  [SERVER_EVENT.strategyFailed]: StrategyFailedEvent;
}
