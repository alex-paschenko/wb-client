// app/src/server/services/frontend-ws.ts

import { WebSocket } from 'ws';

import { CLIENT_VERSION } from '../../shared/constants/client-version.js';
import {
  FRONTEND_WS_CONTROL_MESSAGE_TYPES,
  FRONTEND_WS_SUBSCRIPTION_ACTIONS,
  FRONTEND_WS_SUBSCRIPTION_ENTITIES,
} from '../../shared/constants/frontend-ws.js';
import { FRONTEND_WS_CODEC } from '../../shared/constants/settings.js';
import {
  MINUTE,
  SECOND,
  SECONDS,
} from '../../shared/constants/time.js';
import { temporaryUserId } from '../../shared/constants/users.js';
import { globalStateService } from '../../shared/services/global-state.js';
import { FrontendSettings } from '../../shared/services/frontend-settings.js';
import type {
  FrontendWsChangeSubscriptionMessage,
  FrontendWsClientControlMessage,
  FrontendWsRequestStorageEntitiesMessage,
  FrontendWsRequestMarketStatisticsFullSyncMessage,
  FrontendWsSetSubscriptionMessage,
  FrontendWsSettingsChangedMessage,
} from '../../shared/types/frontend-ws.js';
import {
  SERVER_WS_EVENT_TYPE,
  type ServerWsJsonMessage,
} from '../../shared/types/server-events.js';
import { encodeCodec } from '../../shared/utilities/codecs/codecs.js';
import { SERVER_EVENT } from '../constants/events.js';
import { getWsServer } from '../frontend/index.js';
import type {
  ServerEventMap,
  StorageDeltaCreatedEvent,
  StorageFullSyncResultsEvent,
} from '../types/events.js';
import type {
  MarketRollingStatisticsByMarket,
} from '../types/market-statistics.js';
import { eventBus } from './event-bus.js';
import { frontendSettingsService } from './frontend-settings.js';
import { marketStatisticsRollingService } from './market-statistics-rolling.js';

const SERVER_EVENT_EXPIRATION = 1 * MINUTE;
const FULL_SYNC_SUBSCRIPTION_TIMEOUT = 10 * SECONDS;
const FULL_SYNC_WATCHDOG_INTERVAL = 1 * SECOND;

let serverEventId = 0;

type MarketStatisticsSubscriptionState = Map<string, number>;
type MarketRollingSubscriptionState = Map<string, number>;
type PendingFullSyncState = Map<string, number>;

interface PendingServerEvent {
  socket: WebSocket;
  clientId: number;
  validUntil: number;
}

type ServerEventWithIdName = {
  [K in keyof ServerEventMap]:
    ServerEventMap[K] extends { eventId: number }
      ? K
      : never;
}[keyof ServerEventMap];

type ServerEventData<K extends ServerEventWithIdName> =
  Omit<ServerEventMap[K], 'eventId'>;

type FrontendWsClientState = {
  isReady: boolean;
  settings: FrontendSettings;
  nextServerId: number;
  marketInfoSubscription: { clientId: number; isSubscribed: boolean; };
  marketStatisticsSubscription: MarketStatisticsSubscriptionState;
  marketRollingSubscription: MarketRollingSubscriptionState;
  marketsBetweenFullSyncAndSubscription: PendingFullSyncState;
};

export class FrontendWsService {
  private readonly clients = new Map<WebSocket, FrontendWsClientState>();

  private readonly serverEvents = new Map<number, PendingServerEvent>();

  private serverEventExpirationTimer:
    ReturnType<typeof setInterval> | null = null;
  private fullSyncWatchdogTimer:
    ReturnType<typeof setInterval> | null = null;

  public start(): void {
    const wsServer = getWsServer();

    wsServer.onConnection((socket) => {
      this.clients.set(socket, this.createClientState());
      this.sendServerHello(socket);
    });

    wsServer.onDisconnect((socket) => {
      this.handleClientClose(socket);
    });

    wsServer.onMessage((socket, data) => {
      this.handleClientMessage(socket, data);
    });

    eventBus.on(
      SERVER_EVENT.storageDeltaCreated,
      (event) => this.handleStorageDeltaCreated(event),
    );

    eventBus.on(
      SERVER_EVENT.storageFullSyncResults,
      (event) => this.handleStorageFullSyncResults(event),
    );

    eventBus.on(
      SERVER_EVENT.marketRollingUpdated,
      (event) => {
        this.handleMarketRollingUpdated(event.rollingStatisticsByMarket);
      },
    );

    eventBus.on(
      SERVER_EVENT.marketsInfoUpdated,
      () => { this.broadcastMarketsUpdated(); },
    );

    this.serverEventExpirationTimer = setInterval(
      () => { this.clearExpiredServerEvents(); },
      SERVER_EVENT_EXPIRATION,
    );

    this.fullSyncWatchdogTimer = setInterval(
      () => { this.processFullSyncWatchdog(); },
      FULL_SYNC_WATCHDOG_INTERVAL,
    );
  }

  private handleClientClose(socket: WebSocket): void {
    const state = this.clients.get(socket);

    if (state) {
      for (
        const marketName of
        state.marketsBetweenFullSyncAndSubscription.keys()
      ) {
        this.lowerStatisticsStorageFreeze(marketName);
      }
    }

    for (const [eventId, pending] of this.serverEvents) {
      if (pending.socket === socket) {
        this.serverEvents.delete(eventId);
      }
    }

    this.clients.delete(socket);
  }

  private lowerStatisticsStorageFreeze(marketName: string): void {
    eventBus.emit(
      SERVER_EVENT.freezeOnStorageNeedsToBeLowered,
      { marketName },
    );
  }

  private createClientState(): FrontendWsClientState {
    return {
      isReady: false,
      settings: FrontendSettings.createDefault(),
      nextServerId: 1,
      marketInfoSubscription: { clientId: 0, isSubscribed: false },
      marketStatisticsSubscription: new Map(),
      marketRollingSubscription: new Map(),
      marketsBetweenFullSyncAndSubscription: new Map(),
    };
  }

  private sendServerHello(socket: WebSocket): void {
    getWsServer().sendJson(socket, {
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.serverHello,
      latestClientVersion: CLIENT_VERSION,
      serverTime: Date.now(),
    });
  }

  private handleClientMessage(
    socket: WebSocket,
    data: WebSocket.RawData,
  ): void {
    const message = this.parseClientControlMessage(data);

    if (!message) {
      return;
    }

    if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.webSocketReady) {
      this.handleWebSocketReady(socket);
      return;
    }

    if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.requestSettings) {
      void this.handleRequestSettings(socket, message.clientId);
      return;
    }

    if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.settingsChanged) {
      void this.handleSettingsChanged(socket, message);
      return;
    }

    if (
      message.type ===
      FRONTEND_WS_CONTROL_MESSAGE_TYPES.requestStorageEntities
    ) {
      this.handleRequestStorageEntities(socket, message);
      return;
    }

    if (
      message.type ===
      FRONTEND_WS_CONTROL_MESSAGE_TYPES.requestMarketStatisticsFullSync
    ) {
      this.handleRequestMarketStatisticsFullSync(socket, message);
      return;
    }

    if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.setSubscription) {
      this.handleSetSubscription(socket, message);
      return;
    }

    if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.changeSubscription) {
      this.handleChangeSubscription(socket, message);
    }
  }

  private handleMarketRollingUpdated(
    rollingStatisticsByMarket: MarketRollingStatisticsByMarket,
  ): void {
    for (const [socket, state] of this.clients) {
      if (!state.isReady) {
        continue;
      }

      for (
        const [marketName, rollingStatistics]
        of Object.entries(rollingStatisticsByMarket)
      ) {
        const clientId = state.marketRollingSubscription.get(marketName);

        if (clientId === undefined) {
          continue;
        }

        this.sendRollingStatistics(
          socket,
          clientId,
          marketName,
          rollingStatistics,
        );
      }
    }
  }

  private parseClientControlMessage(
    data: WebSocket.RawData,
  ): FrontendWsClientControlMessage | null {
    let message: unknown;

    try {
      message = JSON.parse(data.toString());
    } catch {
      return null;
    }

    if (!message || typeof message !== 'object' || !('type' in message)) {
      return null;
    }

    return message as FrontendWsClientControlMessage;
  }

  private handleWebSocketReady(socket: WebSocket): void {
    const state = this.clients.get(socket);

    if (!state) {
      return;
    }

    state.isReady = true;
  }

  private async handleRequestSettings(
    socket: WebSocket,
    clientId: number,
  ): Promise<void> {
    const state = this.clients.get(socket);

    if (!state) {
      return;
    }

    const settings = await this.loadSettingsForSocket();

    state.settings = settings;

    getWsServer().sendJson(socket, {
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.settingsLoaded,
      clientId,
      params: { settings: settings.toValue() },
    });
  }

  private async handleSettingsChanged(
    socket: WebSocket,
    message: FrontendWsSettingsChangedMessage,
  ): Promise<void> {
    const state = this.clients.get(socket);

    if (!state) {
      return;
    }

    const settings = FrontendSettings.fromValue(message.params.settings);

    state.settings = settings;

    await this.saveSettingsForSocket(settings);

    getWsServer().sendJson(socket, {
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.settingsAccepted,
      clientId: message.clientId,
      params: {},
    });
  }

  private handleRequestStorageEntities(
    socket: WebSocket,
    message: FrontendWsRequestStorageEntitiesMessage,
  ): void {
    const state = this.clients.get(socket);

    if (!state?.isReady) {
      return;
    }

    this.sendStorageEntities(socket, message.clientId);
  }

  private handleRequestMarketStatisticsFullSync(
    socket: WebSocket,
    message: FrontendWsRequestMarketStatisticsFullSyncMessage,
  ): void {
    const state = this.clients.get(socket);

    if (!state?.isReady) {
      return;
    }

    const { marketName } = message.params;

    const freezeStorage =
      !state.marketsBetweenFullSyncAndSubscription.has(marketName);

    state.marketsBetweenFullSyncAndSubscription.set(
      marketName,
      Date.now() + FULL_SYNC_SUBSCRIPTION_TIMEOUT,
    );

    this.sendServerEvent(
      SERVER_EVENT.storageFullSyncRequest,
      { marketName, freezeStorage },
      socket,
      message.clientId,
    );
  }

  private handleStorageFullSyncResults(
    event: StorageFullSyncResultsEvent,
  ): void {
    const pending = this.serverEvents.get(event.eventId);

    if (!pending) {
      return;
    }

    this.serverEvents.delete(event.eventId);

    if (pending.validUntil <= Date.now()) {
      return;
    }

    const state = this.clients.get(pending.socket);

    if (!state?.isReady) {
      return;
    }

    this.sendBinary(
      pending.socket,
      state,
      pending.clientId,
      event.data,
    );
  }

  private handleStorageDeltaCreated(event: StorageDeltaCreatedEvent): void {
    for (const [socket, state] of this.clients) {
      if (!state.isReady) {
        continue;
      }

      const clientId =
        state.marketStatisticsSubscription.get(event.marketName);

      if (clientId === undefined) {
        continue;
      }

      this.sendBinary(socket, state, clientId, event.data);
    }
  }

  private handleSetSubscription(
    socket: WebSocket,
    message: FrontendWsSetSubscriptionMessage,
  ): void {
    const state = this.clients.get(socket);

    if (!state) {
      return;
    }

    if (
      message.params.entity ===
      FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketInfo
    ) {
      state.marketInfoSubscription = {
        clientId: message.clientId,
        isSubscribed: true,
      };

      this.sendMarketsUpdated(socket);
      return;
    }

    throw new Error(
      `Unknown subscription entity: ${message.params.entity}.`,
    );
  }

  private handleChangeSubscription(
    socket: WebSocket,
    message: FrontendWsChangeSubscriptionMessage,
  ): void {
    const state = this.clients.get(socket);

    if (!state) {
      return;
    }

    if (
      message.params.entity ===
      FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketRolling
    ) {
      this.handleMarketRollingSubscriptionChanged(state, socket, message);
      return;
    }

    if (
      message.params.entity !==
      FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketStatistics
    ) {
      return;
    }

    if (message.params.action === FRONTEND_WS_SUBSCRIPTION_ACTIONS.add) {
      for (const marketName of message.params.markets) {
        state.marketStatisticsSubscription.set(
          marketName,
          message.clientId,
        );

        if (state.marketsBetweenFullSyncAndSubscription.delete(marketName)) {
          this.lowerStatisticsStorageFreeze(marketName);
        }
      }

      return;
    }

    for (const marketName of message.params.markets) {
      state.marketStatisticsSubscription.delete(marketName);

      if (state.marketsBetweenFullSyncAndSubscription.delete(marketName)) {
        this.lowerStatisticsStorageFreeze(marketName);
      }
    }
  }

  private handleMarketRollingSubscriptionChanged(
    state: FrontendWsClientState,
    socket: WebSocket,
    message: FrontendWsChangeSubscriptionMessage,
  ): void {
    if (message.params.action === FRONTEND_WS_SUBSCRIPTION_ACTIONS.add) {
      for (const marketName of message.params.markets) {
        state.marketRollingSubscription.set(marketName, message.clientId);
      }

      this.sendRollingSnapshot(socket, message.clientId, message.params.markets);
      return;
    }

    for (const marketName of message.params.markets) {
      state.marketRollingSubscription.delete(marketName);
    }
  }

  private sendBinary(
    socket: WebSocket,
    state: FrontendWsClientState,
    clientId: number,
    data: Uint8Array<ArrayBufferLike>,
  ): void {
    const packet = encodeCodec(
      FRONTEND_WS_CODEC,
      {
        serverId: this.getNextServerId(state),
        clientId,
        data,
      },
    );

    getWsServer().sendBinary(socket, packet);
  }

  private sendServerEvent<K extends ServerEventWithIdName>(
    eventName: K,
    eventData: ServerEventData<K>,
    socket: WebSocket,
    clientId: number,
  ): void {
    const eventId = serverEventId++;

    this.serverEvents.set(
      eventId,
      {
        socket,
        clientId,
        validUntil: Date.now() + SERVER_EVENT_EXPIRATION,
      },
    );

    eventBus.emit(
      eventName,
      {
        ...eventData,
        eventId,
      } as ServerEventMap[K],
    );
  }

  private processFullSyncWatchdog(): void {
    const now = Date.now();

    for (const [socket, state] of this.clients) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      for (
        const validUntil of
        state.marketsBetweenFullSyncAndSubscription.values()
      ) {
        if (validUntil > now) {
          continue;
        }

        socket.close(
          1008,
          'Full sync subscription timeout',
        );

        break;
      }
    }
  }

  private clearExpiredServerEvents(): void {
    const now = Date.now();

    for (const [eventId, event] of this.serverEvents) {
      if (event.validUntil <= now) {
        this.serverEvents.delete(eventId);
      }
    }
  }

  private sendStorageEntities(
    socket: WebSocket,
    clientId: number,
  ): void {
    getWsServer().sendJson(socket, {
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.storageEntitiesLoaded,
      clientId,
      params: {
        entities: globalStateService.getStorageEntities(),
      },
    });
  }

  private getNextServerId(state: FrontendWsClientState): number {
    const serverId = state.nextServerId;

    state.nextServerId += 1;

    return serverId;
  }

  private sendRollingSnapshot(
    socket: WebSocket,
    clientId: number,
    marketNames: string[],
  ): void {
    for (const marketName of marketNames) {
      const rollingStatistics =
        marketStatisticsRollingService.getByMarketName(marketName);

      if (!rollingStatistics) {
        continue;
      }

      this.sendRollingStatistics(
        socket,
        clientId,
        marketName,
        rollingStatistics,
      );
    }
  }

  private sendRollingStatistics(
    socket: WebSocket,
    clientId: number,
    marketName: string,
    rollingStatistics: MarketRollingStatisticsByMarket[string],
  ): void {
    getWsServer().sendJson(socket, {
      type: SERVER_WS_EVENT_TYPE.marketRollingUpdated,
      clientId,
      payload: { marketName, rollingStatistics },
    });
  }

  private sendMarketsUpdated(socket: WebSocket): void {
    getWsServer().sendJson(socket, {
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.marketsUpdated,
      markets: globalStateService.getMarkets(),
    });
  }

  private broadcastMarketsUpdated(): void {
    const message = {
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.marketsUpdated,
      markets: globalStateService.getMarkets(),
    } satisfies ServerWsJsonMessage;

    for (const [socket, state] of this.clients) {
      if (!state.isReady || !state.marketInfoSubscription.isSubscribed) {
        continue;
      }

      getWsServer().sendJson(socket, message);
    }
  }

  private async loadSettingsForSocket(): Promise<FrontendSettings> {
    const settingsValue =
      await frontendSettingsService.getByUserId(temporaryUserId);

    return FrontendSettings.fromValue(settingsValue);
  }

  private async saveSettingsForSocket(
    settings: FrontendSettings,
  ): Promise<void> {
    await frontendSettingsService.saveByUserId(
      temporaryUserId,
      settings.toValue(),
    );
  }
}

export const frontendWsService = new FrontendWsService();
