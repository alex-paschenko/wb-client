// app/src/server/types/events.ts

import type { EntityDesriptor } from '../../shared/types/storage-entities.js';
import type {
  MarketRollingStatistics,
  MarketRollingStatisticsByMarket,
} from '../../shared/types/market-statistics-rolling.js';
import type { SERVER_EVENT } from '../constants/events.js';
import type { Order, OrderError } from '../../shared/types/order-receipt.js';
import type { MarketTick } from '../../shared/types/ticks.js';
import type { ResearchSnapshot } from '../../shared/types/research-storage.js';
import type { MarketsByName, MarketFeesByName } from '../../shared/types/market.js';
import type {
  ExtendedStoragePersistenceSnapshot,
  StorageAccessors,
} from '../../shared/types/storage.js';
import type {
  RawOrderBookDepth,
  OrderBookSubscription,
} from './order-book-depth.js';
import type {
  OrderCancel,
  OrderKind,
  OrderCreateRequest,
} from './orders.js';
import type {
  DepthPersistence,
  StrategyStateChangePersistence,
} from './persistence.js';

export type ServerEventName = typeof SERVER_EVENT[keyof typeof SERVER_EVENT];

export interface MarketDataUpdatedEvent {
  markets: MarketsByName;
  marketFees: MarketFeesByName;
  marketNames: string[];
}

export interface MarketRollingTickReceivedEvent {
  marketName: string;
  rollingStatistics: MarketRollingStatistics;
}

export interface MarketRollingUpdatedEvent {
  rollingStatisticsByMarket: MarketRollingStatisticsByMarket;
}

export interface MarketTickReceivedEvent {
  marketName: string;
  tick: MarketTick;
}

export interface RecalculateEntitiesRequestEvent {
  accessors: StorageAccessors;
  marketName: string;
  size: number;
  endedAt: number;
}

export interface EntitiesRecalculatedEvent {
  marketName: string;
  size: number;
  endedAt: number;
}

export interface StorageSnapshotedEvent {
  snapshots: ExtendedStoragePersistenceSnapshot[];
}

export interface StorageDeltaCreatedEvent {
  data: Uint8Array<ArrayBufferLike>;
  marketName: string;
}

export interface StorageFullSyncRequestEvent {
  marketName: string;
  eventId: number;
}

export interface StorageFullSyncResultsEvent {
  marketName: string;
  eventId: number;
  data: Uint8Array<ArrayBufferLike>;
}

export interface AddStorageEntitiesEvent {
  entities: EntityDesriptor[];
}

export interface MarketRemovedEvent {
  marketName: string;
}

export type OrderBookDepthSubscriptionEvent = OrderBookSubscription;

export type OrderBookDepthUpdateEvent = RawOrderBookDepth;

export interface RunStrategiesRequestEvent {
  accessors: StorageAccessors;
  marketName: string;
  size: number;
  endedAt: number;
}

export interface StrategiesCompletedEvent {
  marketName: string;
  size: number;
  endedAt: number;
  error?: unknown;
}

export type CreateOrderRequestAndSubscribeEvent = (
  | OrderCreateRequest
  | { orderType: null; orderRequest: null }
) & {
  subscription: string[] | null;
  isPaperTrading: boolean;
};

export interface OrderUpdatedEvent {
  order: Order;
  eventId: 1 | 2 | 3;
  isPaperTrading: boolean;
}

export type OrderCancelEvent = OrderCancel;

export interface OrderRequestResultEvent {
  marketName: string;
  client_order_id: number;
  error: OrderError | null;
  isPaperTrading: boolean;
}

export interface OrderPersistenceRequestEvent {
  marketName: string;
  receivedAt: number;
  client_order_id: number;
  strategyName: string;
  orderKind: OrderKind;
  isPaperTrading: boolean;
  order: Order | null;
  isFinalized: boolean;
  isOrderUpdated: boolean;
  error: OrderError | null | undefined;
}

export type DepthPersistenceRequestEvent = DepthPersistence;

export interface StrategyStatePersistenceRequestEvent {
  changes: StrategyStateChangePersistence[];
}

export interface ServerEventMap {
  [SERVER_EVENT.marketDataUpdated]: MarketDataUpdatedEvent;

  [SERVER_EVENT.marketRemoved]: MarketRemovedEvent;

  [SERVER_EVENT.marketRollingTickReceived]: MarketRollingTickReceivedEvent;
  [SERVER_EVENT.marketRollingUpdated]: MarketRollingUpdatedEvent;

  [SERVER_EVENT.marketTickReceived]: MarketTickReceivedEvent;

  [SERVER_EVENT.addStorageEntities]: AddStorageEntitiesEvent;
  [SERVER_EVENT.recalculateEntitiesRequest]: RecalculateEntitiesRequestEvent;
  [SERVER_EVENT.entitiesRecalculated]: EntitiesRecalculatedEvent;

  [SERVER_EVENT.storageSnapshoted]: StorageSnapshotedEvent;
  [SERVER_EVENT.researchPersistenceRequest]: ResearchSnapshot;
  [SERVER_EVENT.storageDeltaCreated]:StorageDeltaCreatedEvent;
  [SERVER_EVENT.storageFullSyncRequest]: StorageFullSyncRequestEvent;
  [SERVER_EVENT.storageFullSyncResults]: StorageFullSyncResultsEvent;

  [SERVER_EVENT.orderBookDepthSubscription]: OrderBookDepthSubscriptionEvent;
  [SERVER_EVENT.orderBookDepthUpdate]: OrderBookDepthUpdateEvent;

  [SERVER_EVENT.runStrategiesRequest]: RunStrategiesRequestEvent;
  [SERVER_EVENT.strategiesCompleted]: StrategiesCompletedEvent;

  [SERVER_EVENT.orderRequestResult]: OrderRequestResultEvent;
  [SERVER_EVENT.createOrderRequestAndSubscribe]:
    CreateOrderRequestAndSubscribeEvent;
  [SERVER_EVENT.orderUpdated]: OrderUpdatedEvent;
  [SERVER_EVENT.orderCancelRequest]: OrderCancelEvent;

  [SERVER_EVENT.depthPersistenceRequest]: DepthPersistenceRequestEvent;
  [SERVER_EVENT.orderPersistenceRequest]: OrderPersistenceRequestEvent;
  [SERVER_EVENT.strategyStatePersistenceRequest]:
    StrategyStatePersistenceRequestEvent;
}
