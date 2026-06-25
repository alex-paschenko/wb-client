import { TextEncoder } from 'node:util';
import { WebSocket } from 'ws';

import { CLIENT_VERSION } from '../../shared/constants/client-version.js';
import {
  FRONTEND_WS_BINARY_MESSAGE_TYPES,
  FRONTEND_WS_CONTROL_MESSAGE_TYPES,
  FRONTEND_WS_SUBSCRIPTION_ACTIONS,
  FRONTEND_WS_SUBSCRIPTION_ENTITIES,
} from '../../shared/constants/frontend-ws.js';
import { temporaryUserId } from '../../shared/constants/users.js';
import { frontendSettingsService } from './frontend-settings.js';
import { FrontendSettings } from '../../shared/services/frontend-settings.js';
import type {
  FrontendWsChangeSubscriptionMessage,
  FrontendWsClientControlMessage,
  FrontendWsPingMessage,
  FrontendWsSetSubscriptionMessage,
  FrontendWsSettingsChangedMessage,
} from '../../shared/types/frontend-ws.js';
import type {
  MarketStatisticsItem,
} from '../../shared/types/market-statistics-storage.js';
import {
  SERVER_WS_EVENT_TYPE,
  type ServerWsJsonMessage,
} from '../../shared/types/server-events.js';
import {
  encodeFrontendWsBinaryPacket,
} from '../../shared/utilities/frontend-ws-binary-codec.js';
import {
  getMarketStatisticsItemByteLength,
  writeMarketStatisticsItemToDataView,
} from '../../shared/utilities/market-statistics-codec.js';
import { SERVER_EVENT } from '../constants/events.js';
import { getWsServer } from '../frontend/index.js';
import type {
  MarketStatisticsStorageChangedEvent,
} from '../types/events.js';
import { eventBus } from './event-bus.js';
import { marketStatisticsAggregationService } from './market-statistics-aggregation.js';
import { marketStatisticsRollingService } from './market-statistics-rolling.js';
import { marketsService } from './markets.js';

type MarketStatisticsSubscriptionState = {
  clientId: number;
  markets: Set<string>;
};

type FrontendWsClientState = {
  isReady: boolean;
  settings: FrontendSettings;
  nextServerId: number;
  marketStatisticsSubscription: MarketStatisticsSubscriptionState;
};

const encoder = new TextEncoder();

export class FrontendWsService {
  private readonly clients = new Map<WebSocket, FrontendWsClientState>();

  public start(): void {
    const wsServer = getWsServer();

    wsServer.onConnection((socket) => {
      this.clients.set(socket, this.createClientState());

      socket.on('close', () => {
        this.clients.delete(socket);
      });

      this.sendServerHello(socket);
    });

    wsServer.onMessage((socket, data) => {
      this.handleClientMessage(socket, data);
    });

    eventBus.on(
      SERVER_EVENT.marketStatisticsStorageChanged,
      (event) => this.handleMarketStatisticsStorageChanged(event),
    );

    eventBus.on(
      SERVER_EVENT.marketRollingUpdated,
      (event) => {
        this.broadcastJsonToReadyClients({
          type: SERVER_WS_EVENT_TYPE.marketRollingUpdated,
          payload: event,
        });
      },
    );

    eventBus.on(
      SERVER_EVENT.marketsInfoUpdated,
      () => {
        this.broadcastMarketsUpdated();
      },
    );
  }

  private createClientState(): FrontendWsClientState {
    return {
      isReady: false,
      settings: FrontendSettings.createDefault(),
      nextServerId: 1,
      marketStatisticsSubscription: {
        clientId: 0,
        markets: new Set(),
      },
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

    if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.ping) {
      this.handlePing(socket, message);
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

    if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.setSubscription) {
      this.handleSetSubscription(socket, message);
      return;
    }

    if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.changeSubscription) {
      this.handleChangeSubscription(socket, message);
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

    if (
      !message ||
      typeof message !== 'object' ||
      !('type' in message)
    ) {
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
    this.sendMarketsUpdated(socket);
    this.sendRollingSnapshot(socket);
  }

  private handlePing(
    socket: WebSocket,
    message: FrontendWsPingMessage,
  ): void {
    getWsServer().sendJson(socket, {
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.pong,
      clientId: message.clientId,
      params: {
        sentAt: message.params.sentAt,
        receivedAt: Date.now(),
      },
    });
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
      params: {
        settings: settings.toValue(),
      },
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

  private handleSetSubscription(
    socket: WebSocket,
    message: FrontendWsSetSubscriptionMessage,
  ): void {
    const state = this.clients.get(socket);

    if (
      !state ||
      message.params.entity !== FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketStatistics
    ) {
      return;
    }

    state.marketStatisticsSubscription = {
      clientId: message.clientId,
      markets: new Set(message.params.markets),
    };

    for (const marketName of message.params.markets) {
      this.sendFullMarketStatistics(
        socket,
        state,
        marketName,
      );
    }
  }

  private handleChangeSubscription(
    socket: WebSocket,
    message: FrontendWsChangeSubscriptionMessage,
  ): void {
    const state = this.clients.get(socket);

    if (
      !state ||
      message.params.entity !== FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketStatistics
    ) {
      return;
    }

    if (message.clientId !== state.marketStatisticsSubscription.clientId) {
      return;
    }

    if (message.params.action === FRONTEND_WS_SUBSCRIPTION_ACTIONS.add) {
      for (const marketName of message.params.markets) {
        state.marketStatisticsSubscription.markets.add(marketName);

        this.sendFullMarketStatistics(
          socket,
          state,
          marketName,
        );
      }

      return;
    }

    if (message.params.action === FRONTEND_WS_SUBSCRIPTION_ACTIONS.remove) {
      for (const marketName of message.params.markets) {
        state.marketStatisticsSubscription.markets.delete(marketName);
      }
    }
  }

  private handleMarketStatisticsStorageChanged(
    event: MarketStatisticsStorageChangedEvent,
  ): void {
    const payload = this.encodeMarketStatisticsDeltaPayload(
      event.marketName,
      event.delta,
    );

    for (const [socket, state] of this.clients) {
      if (
        !state.isReady ||
        !state.marketStatisticsSubscription.markets.has(event.marketName)
      ) {
        continue;
      }

      this.sendMarketStatisticsPacket(
        socket,
        state,
        FRONTEND_WS_BINARY_MESSAGE_TYPES.marketStatisticsDelta,
        payload,
      );
    }
  }

  private sendFullMarketStatistics(
    socket: WebSocket,
    state: FrontendWsClientState,
    marketName: string,
  ): void {
    const levels =
      marketStatisticsAggregationService.getStorageItemsByMarket()[marketName];

    if (!levels) {
      return;
    }

    const payload = this.encodeFullMarketStatisticsPayload(
      marketName,
      levels,
    );

    this.sendMarketStatisticsPacket(
      socket,
      state,
      FRONTEND_WS_BINARY_MESSAGE_TYPES.fullMarketStatistics,
      payload,
    );
  }

  private sendMarketStatisticsPacket(
    socket: WebSocket,
    state: FrontendWsClientState,
    messageType: number,
    payload: ArrayBuffer,
  ): void {
    const packet = encodeFrontendWsBinaryPacket(
      {
        messageType,
        serverId: this.getNextServerId(state),
        clientId: state.marketStatisticsSubscription.clientId,
      },
      payload,
    );

    getWsServer().sendBinary(socket, packet);
  }

  private getNextServerId(state: FrontendWsClientState): number {
    const serverId = state.nextServerId;

    state.nextServerId += 1;

    return serverId;
  }

  private sendRollingSnapshot(socket: WebSocket): void {
    getWsServer().sendJson(socket, {
      type: SERVER_WS_EVENT_TYPE.marketRollingUpdated,
      payload: {
        rollingStatisticsByMarket: marketStatisticsRollingService.getAll(),
      },
    });
  }

  private sendMarketsUpdated(socket: WebSocket): void {
    getWsServer().sendJson(socket, {
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.marketsUpdated,
      markets: marketsService.getActiveMarkets(),
    });
  }

  private broadcastMarketsUpdated(): void {
    const message = {
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.marketsUpdated,
      markets: marketsService.getActiveMarkets(),
    } satisfies ServerWsJsonMessage;

    this.broadcastJsonToReadyClients(message);
  }

  private encodeMarketStatisticsDeltaPayload(
    marketName: string,
    delta: ArrayBuffer,
  ): ArrayBuffer {
    const marketNameBytes = encoder.encode(marketName);

    const byteLength =
      2 +
      marketNameBytes.byteLength +
      delta.byteLength;

    const buffer = new ArrayBuffer(byteLength);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    let offset = 0;

    view.setUint16(offset, marketNameBytes.byteLength, true);
    offset += 2;

    bytes.set(marketNameBytes, offset);
    offset += marketNameBytes.byteLength;

    bytes.set(new Uint8Array(delta), offset);

    return buffer;
  }

  private encodeFullMarketStatisticsPayload(
    marketName: string,
    levels: MarketStatisticsItem[][],
  ): ArrayBuffer {
    const marketNameBytes = encoder.encode(marketName);
    const payloadByteLength = this.getFullMarketStatisticsPayloadByteLength(
      levels,
    );

    const byteLength =
      2 +
      marketNameBytes.byteLength +
      1 +
      payloadByteLength;

    const buffer = new ArrayBuffer(byteLength);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    let offset = 0;

    view.setUint16(offset, marketNameBytes.byteLength, true);
    offset += 2;

    bytes.set(marketNameBytes, offset);
    offset += marketNameBytes.byteLength;

    view.setUint8(offset, levels.length);
    offset += 1;

    for (const [level, items] of levels.entries()) {
      view.setUint16(offset, items.length, true);
      offset += 2;

      for (const item of items) {
        offset = writeMarketStatisticsItemToDataView(
          view,
          offset,
          level,
          item,
        );
      }
    }

    return buffer;
  }

  private getFullMarketStatisticsPayloadByteLength(
    levels: MarketStatisticsItem[][],
  ): number {
    return levels.reduce((sum, items, level) => {
      return sum + 2 + items.length * getMarketStatisticsItemByteLength(level);
    }, 0);
  }

  private broadcastJsonToReadyClients(message: ServerWsJsonMessage): void {
    for (const [socket, state] of this.clients) {
      if (!state.isReady) {
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
