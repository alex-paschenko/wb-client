// app/src/server/services/frontend-ws.ts
import { WebSocket } from 'ws';

import {
  CLIENT_VERSION,
} from '../../shared/constants/client-version.js';
import {
  FRONTEND_WS_BINARY_MESSAGE_TYPES,
  FRONTEND_WS_CONTROL_MESSAGE_TYPES,
  FRONTEND_WS_SUBSCRIPTION_ACTIONS,
  FRONTEND_WS_SUBSCRIPTION_ENTITIES,
} from '../../shared/constants/frontend-ws.js';
import { temporaryUserId } from '../../shared/constants/users.js';
import {
  FrontendSettings,
} from '../../shared/services/frontend-settings.js';
import type {
  FrontendWsChangeSubscriptionMessage,
  FrontendWsClientControlMessage,
  FrontendWsRequestMarketIndicatorsRegistryMessage,
  FrontendWsRequestMarketStatisticsFullSyncMessage,
  FrontendWsSetSubscriptionMessage,
  FrontendWsSettingsChangedMessage,
} from '../../shared/types/frontend-ws.js';
import type {
  FullMarketStatisticsLevel,
} from '../../shared/types/market-statistics-storage.js';
import {
  SERVER_WS_EVENT_TYPE,
  type ServerWsJsonMessage,
} from '../../shared/types/server-events.js';
import {
  encodeFrontendWsBinaryPacket,
} from '../../shared/utilities/frontend-ws-binary-codec.js';
import {
  encodeFullMarketStatisticsPayload,
  encodeMarketStatisticsBinaryPayload,
} from '../../shared/utilities/market-statistics-payload-codec.js';
import { SERVER_EVENT } from '../constants/events.js';
import { getWsServer } from '../frontend/index.js';
import type {
  MarketStatisticsIndicatorsChangedEvent,
  MarketStatisticsStorageChangedEvent,
} from '../types/events.js';
import type {
  MarketRollingStatisticsByMarket,
} from '../types/market-statistics.js';
import { eventBus } from './event-bus.js';
import { frontendSettingsService } from './frontend-settings.js';
import {
  marketStatisticsAggregationService,
} from './market-statistics-aggregation.js';
import {
  marketStatisticsRollingService,
} from './market-statistics-rolling.js';
import {
  globalStateService
} from '../../shared/services/global-state.js';

type MarketSubscriptionState = Set<string>;

type FrontendWsClientState = {
  isReady: boolean;
  settings: FrontendSettings;
  nextServerId: number;
  marketInfoSubscription: {
    clientId: number;
    isSubscribed: boolean;
  };
  marketStatisticsSubscription: MarketSubscriptionState;
  marketRollingSubscription: MarketSubscriptionState;
  marketsBetweenFullSyncAndSubscription: MarketSubscriptionState;
};

export class FrontendWsService {
  private readonly clients =
    new Map<WebSocket, FrontendWsClientState>();

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
      SERVER_EVENT.marketStatisticsStorageChanged,
      (event) => this.handleMarketStatisticsStorageChanged(event),
    );

    eventBus.on(
      SERVER_EVENT.marketStatisticsIndicatorsChanged,
      (event) => this.handleMarketStatisticsIndicatorsChanged(event),
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
  }

  private handleClientClose(
    socket: WebSocket,
  ): void {
    const state = this.clients.get(socket);

    if (state) {
      for (
        const marketName
        of state.marketsBetweenFullSyncAndSubscription
      ) {
        this.lowerStatisticsStorageFreeze(marketName);
      }
    }

    this.clients.delete(socket);
  }

  private lowerStatisticsStorageFreeze(
    marketName: string,
  ): void {
    eventBus.emit(
      SERVER_EVENT.freezeOnStatisticsStorageNeedsToBeLowered,
      { marketName },
    );
  }

  private createClientState(): FrontendWsClientState {
    return {
      isReady: false,
      settings: FrontendSettings.createDefault(),
      nextServerId: 1,
      marketInfoSubscription: { clientId: 0, isSubscribed: false },
      marketStatisticsSubscription: new Set(),
      marketRollingSubscription: new Set(),
      marketsBetweenFullSyncAndSubscription: new Set(),
    };
  }

  private sendServerHello(
    socket: WebSocket,
  ): void {
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

    if (
      message.type ===
      FRONTEND_WS_CONTROL_MESSAGE_TYPES.webSocketReady
    ) {
      this.handleWebSocketReady(socket);
      return;
    }

    if (
      message.type ===
      FRONTEND_WS_CONTROL_MESSAGE_TYPES.requestSettings
    ) {
      void this.handleRequestSettings(socket, message.clientId);
      return;
    }

    if (
      message.type ===
      FRONTEND_WS_CONTROL_MESSAGE_TYPES.settingsChanged
    ) {
      void this.handleSettingsChanged(socket, message);
      return;
    }

    if (
      message.type ===
      FRONTEND_WS_CONTROL_MESSAGE_TYPES
        .requestMarketIndicatorsRegistry
    ) {
      this.handleRequestMarketIndicatorsRegistry(socket, message);
      return;
    }

    if (
      message.type ===
      FRONTEND_WS_CONTROL_MESSAGE_TYPES.requestMarketStatisticsFullSync
    ) {
      this.handleRequestMarketStatisticsFullSync(socket, message);
      return;
    }

    if (
      message.type ===
      FRONTEND_WS_CONTROL_MESSAGE_TYPES.setSubscription
    ) {
      this.handleSetSubscription(socket, message);
      return;
    }

    if (
      message.type ===
      FRONTEND_WS_CONTROL_MESSAGE_TYPES.changeSubscription
    ) {
      this.handleChangeSubscription(socket, message);
    }
  }

  private handleMarketRollingUpdated(
    rollingStatisticsByMarket:
      MarketRollingStatisticsByMarket,
  ): void {
    for (const [socket, state] of this.clients) {
      if (!state.isReady) {
        continue;
      }

      const subscribedRolling =
        this.filterSubscribedRollingStatistics(
          rollingStatisticsByMarket,
          state.marketRollingSubscription,
        );

      if (Object.keys(subscribedRolling).length === 0) {
        continue;
      }

      getWsServer().sendJson(socket, {
        type: SERVER_WS_EVENT_TYPE.marketRollingUpdated,
        payload: { rollingStatisticsByMarket: subscribedRolling },
      });
    }
  }

  private filterSubscribedRollingStatistics(
    rollingStatisticsByMarket:
      MarketRollingStatisticsByMarket,
    markets: Set<string>,
  ): MarketRollingStatisticsByMarket {
    const result: MarketRollingStatisticsByMarket = {};

    for (const marketName of markets) {
      const rollingStatistics = rollingStatisticsByMarket[marketName];

      if (rollingStatistics) {
        result[marketName] = rollingStatistics;
      }
    }

    return result;
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

    if (
      !message || typeof message !== 'object' || !('type' in message)
    ) {
      return null;
    }

    return message as FrontendWsClientControlMessage;
  }

  private handleWebSocketReady(
    socket: WebSocket,
  ): void {
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

    const settings = FrontendSettings.fromValue(
      message.params.settings,
    );

    state.settings = settings;

    await this.saveSettingsForSocket(settings);

    getWsServer().sendJson(socket, {
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.settingsAccepted,
      clientId: message.clientId,
      params: {},
    });
  }

  private handleRequestMarketIndicatorsRegistry(
    socket: WebSocket,
    message:
      FrontendWsRequestMarketIndicatorsRegistryMessage,
  ): void {
    const state = this.clients.get(socket);

    if (!state?.isReady) {
      return;
    }

    this.sendMarketIndicatorsRegistry(socket, message.clientId);
  }

  private handleRequestMarketStatisticsFullSync(
    socket: WebSocket,
    message: FrontendWsRequestMarketStatisticsFullSyncMessage,
  ): void {
    const state = this.clients.get(socket);

    if (!state) {
      return;
    }

    const { marketName } = message.params;

    const shouldFreeze =
      !state.marketsBetweenFullSyncAndSubscription.has(marketName);

    if (shouldFreeze) {
      state.marketsBetweenFullSyncAndSubscription.add(marketName);
    }

    const levels = shouldFreeze
      ? marketStatisticsAggregationService
          .createFullSyncSnapshot(marketName)
      : marketStatisticsAggregationService
          .getStorageItemsByMarket()[marketName];

    if (!levels) {
      return;
    }

    this.sendFullMarketStatistics(
      socket,
      state,
      message.clientId,
      marketName,
      levels,
    );
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

    if (
      message.params.entity !==
      FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketStatistics
    ) {
      return;
    }

    state.marketStatisticsSubscription =
      new Set(message.params.markets);
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
      this.handleMarketRollingSubscriptionChanged(
        state,
        socket,
        message,
      );

      return;
    }

    if (
      message.params.entity !==
      FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketStatistics
    ) {
      return;
    }

    if (
      message.params.action ===
      FRONTEND_WS_SUBSCRIPTION_ACTIONS.add
    ) {
      for (const marketName of message.params.markets) {
        state.marketStatisticsSubscription.add(marketName);

        if (
          state.marketsBetweenFullSyncAndSubscription.delete(marketName)
        ) {
          /*
           * The delta stream will continue after the snapshot,
           * so the storage can be unfrozen now.
           */
          this.lowerStatisticsStorageFreeze(marketName);
        }
      }

      return;
    }

    for (const marketName of message.params.markets) {
      state.marketStatisticsSubscription.delete(marketName);
    }
  }

  private handleMarketRollingSubscriptionChanged(
    state: FrontendWsClientState,
    socket: WebSocket,
    message: FrontendWsChangeSubscriptionMessage,
  ): void {
    if (
      message.params.action === FRONTEND_WS_SUBSCRIPTION_ACTIONS.add
    ) {
      for (const marketName of message.params.markets) {
        state.marketRollingSubscription.add(marketName);
      }

      this.sendRollingSnapshot(socket, message.params.markets);

      return;
    }

    for (const marketName of message.params.markets) {
      state.marketRollingSubscription.delete(marketName);
    }
  }

  private handleMarketStatisticsStorageChanged(
    event: MarketStatisticsStorageChangedEvent,
  ): void {
    this.broadcastMarketStatisticsChange(
      event.marketName,
      FRONTEND_WS_BINARY_MESSAGE_TYPES.marketStatisticsDelta,
      event.delta,
    );
  }

  private handleMarketStatisticsIndicatorsChanged(
    event: MarketStatisticsIndicatorsChangedEvent,
  ): void {
    this.broadcastMarketStatisticsChange(
      event.marketName,
      FRONTEND_WS_BINARY_MESSAGE_TYPES.marketStatisticsIndicatorChanges,
      event.changes,
    );
  }

  private broadcastMarketStatisticsChange(
    marketName: string,
    messageType: number,
    changes: ArrayBuffer,
  ): void {
    const payload = encodeMarketStatisticsBinaryPayload(
      marketName,
      changes,
    );

    for (const [socket, state] of this.clients) {
      if (
        !state.isReady ||
        !state.marketStatisticsSubscription.has(marketName)
      ) {
        continue;
      }

      this.sendMarketStatisticsPacket(
        socket,
        state,
        0,
        messageType,
        payload,
      );
    }
  }

  private broadcastMarketStatisticsBinary(
    marketName: string,
    messageType: number,
    payload: ArrayBuffer,
  ): void {
    for (const [socket, state] of this.clients) {
      if (
        !state.isReady ||
        !state.marketStatisticsSubscription.has(marketName)
      ) {
        continue;
      }

      this.sendMarketStatisticsPacket(
        socket,
        state,
        0,
        messageType,
        payload,
      );
    }
  }

  private sendFullMarketStatistics(
    socket: WebSocket,
    state: FrontendWsClientState,
    clientId: number,
    marketName: string,
    levels: FullMarketStatisticsLevel[],
  ): void {
    const payload = encodeFullMarketStatisticsPayload(
      marketName,
      levels,
      globalStateService.getIndicatorRegistry(),
    );

    this.sendMarketStatisticsPacket(
      socket,
      state,
      clientId,
      FRONTEND_WS_BINARY_MESSAGE_TYPES.fullMarketStatistics,
      payload,
    );
  }

  private sendMarketStatisticsPacket(
    socket: WebSocket,
    state: FrontendWsClientState,
    clientId: number,
    messageType: number,
    payload: ArrayBuffer,
  ): void {
    const packet = encodeFrontendWsBinaryPacket(
      {
        messageType,
        serverId: this.getNextServerId(state),
        clientId,
      },
      payload,
    );

    getWsServer().sendBinary(socket, packet);
  }

  private sendMarketIndicatorsRegistry(
    socket: WebSocket,
    clientId: number,
  ): void {
    getWsServer().sendJson(socket, {
      type:
        FRONTEND_WS_CONTROL_MESSAGE_TYPES.marketIndicatorsRegistryLoaded,
      clientId,
      params: { registry: globalStateService.getIndicatorRegistry() },
    });
  }

  private getNextServerId(
    state: FrontendWsClientState,
  ): number {
    const serverId = state.nextServerId;

    state.nextServerId += 1;

    return serverId;
  }

  private sendRollingSnapshot(
    socket: WebSocket,
    marketNames: string[],
  ): void {
    const rollingStatisticsByMarket:
      MarketRollingStatisticsByMarket = {};

    for (const marketName of marketNames) {
      const rollingStatistics =
        marketStatisticsRollingService.getByMarketName(marketName);

      if (rollingStatistics) {
        rollingStatisticsByMarket[marketName] = rollingStatistics;
      }
    }

    if (
      Object.keys(rollingStatisticsByMarket).length === 0
    ) {
      return;
    }

    getWsServer().sendJson(socket, {
      type: SERVER_WS_EVENT_TYPE.marketRollingUpdated,
      payload: { rollingStatisticsByMarket },
    });
  }

  private sendMarketsUpdated(
    socket: WebSocket,
  ): void {
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
      if (
        !state.isReady ||
        !state.marketInfoSubscription.isSubscribed
      ) {
        continue;
      }

      getWsServer().sendJson(socket, message);
    }
  }

  private async loadSettingsForSocket():
    Promise<FrontendSettings> {
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

export const frontendWsService =
  new FrontendWsService();
