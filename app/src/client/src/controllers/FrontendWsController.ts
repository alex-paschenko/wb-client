// app/src/client/src/controllers/FrontendWsController.ts

import { frontendWsClient } from '../api/frontend-ws';
import type { AppContextValue } from '../contexts/AppContext';
import { appEvents } from '../events/app-events';
import { FrontendSettings } from
  '../../../shared/services/frontend-settings';
import {
  FRONTEND_WS_CONTROL_MESSAGE_TYPES,
  FRONTEND_WS_SUBSCRIPTION_ENTITIES,
} from '../../../shared/constants/frontend-ws';
import { FRONTEND_WS_CODEC } from '../../../shared/constants/settings';
import { globalStateService } from '../../../shared/services/global-state';
import type {
  FrontendWsSubscriptionAction,
} from '../../../shared/types/frontend-ws';
import { SERVER_WS_EVENT_TYPE } from '../../../shared/types/server-events';
import { decodeCodec } from
  '../../../shared/utilities/codecs/codecs';
import {
  decodeEntireBinary,
  type PredecodedBinary,
} from '../../../shared/utilities/codecs/entire-binary-codec';

type GetAppContext = () => AppContextValue;

interface StorageBinaryParameters {
  marketName: string;
}

export class FrontendWsController {
  private getAppContext: GetAppContext | null = null;
  private isStarted = false;

  private unsubscribeConnectionState: (() => void) | null = null;
  private unsubscribeJsonMessage: (() => void) | null = null;
  private unsubscribeBinaryMessage: (() => void) | null = null;

  private unsubscribeRequestSettings: (() => void) | null = null;
  private unsubscribeSubscribeMarketInfo: (() => void) | null = null;
  private unsubscribeRequestStorageEntities: (() => void) | null = null;
  private unsubscribeSettingsChanged: (() => void) | null = null;

  private unsubscribeRequestMarketStatisticsFullSync:
    (() => void) | null = null;

  private unsubscribeChangeMarketStatisticsSubscription:
    (() => void) | null = null;

  private unsubscribeChangeMarketRollingSubscription:
    (() => void) | null = null;

  private settingsSaveTimeoutId: number | null = null;
  private lastSettingsToSave: FrontendSettings | null = null;

  private lastServerId = 0;

  public start(getAppContext: GetAppContext): void {
    if (this.isStarted) {
      this.getAppContext = getAppContext;
      return;
    }

    this.isStarted = true;
    this.getAppContext = getAppContext;

    this.unsubscribeConnectionState =
      frontendWsClient.onConnectionStateChange((isConnected) => {
        const appContext = this.getCurrentAppContext();

        appContext.logger.debug(
          isConnected
            ? 'log.messages.wsConnected'
            : 'log.messages.wsDisconnected',
        );

        if (!isConnected) {
          this.clearSessionState();
        }

        appEvents.emit(
          'frontendWsConnectionStateChanged',
          isConnected,
        );
      });

    this.unsubscribeJsonMessage =
      frontendWsClient.onJsonMessage((message) => {
        const appContext = this.getCurrentAppContext();

        if (this.shouldLogJsonMessage(message.type)) {
          appContext.logger.debug(
            `log.messages.wsJson.${message.type}`,
          );
        }

        if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.settingsLoaded) {
          const settings =
            FrontendSettings.fromValue(message.params.settings);

          appContext.logger.debug('log.messages.settingsLoaded');

          appEvents.emit('startupSettingsReceived', settings);
          return;
        }

        if (
          message.type ===
          FRONTEND_WS_CONTROL_MESSAGE_TYPES.settingsAccepted
        ) {
          appContext.logger.debug('log.messages.settingsAccepted');
          return;
        }

        if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.marketsUpdated) {
          globalStateService.setMarkets(
            message.markets,
            Object.keys(message.markets),
          );

          appContext.logger.debug('log.messages.marketsUpdated');

          appEvents.emit('marketsUpdated', message.markets);
          return;
        }

        if (
          message.type ===
          FRONTEND_WS_CONTROL_MESSAGE_TYPES.storageEntitiesLoaded
        ) {
          globalStateService.setStorageEntities(message.params.entities);

          appContext.logger.debug(
            'log.messages.storageEntitiesLoaded',
          );

          appEvents.emit(
            'startupStorageEntitiesReceived',
            message.params.entities,
          );

          return;
        }

        if (message.type === SERVER_WS_EVENT_TYPE.marketRollingUpdated) {
          appEvents.emit(
            {
              eventName: 'marketRollingUpdated',
              condition: message.payload.marketName,
            },
            message.clientId,
            message.payload.rollingStatistics,
          );

          return;
        }
      });

    this.unsubscribeBinaryMessage =
      frontendWsClient.onBinaryMessage((data) => {
        try {
          this.handleBinaryMessage(data);
        } catch (error) {
          const appContext = this.getCurrentAppContext();

          const message = error instanceof Error
            ? error.stack ?? error.message
            : String(error);

          appContext.logger.error(
            `Binary WS processing failed: ${message}`,
          );

          this.clearSessionState();
          frontendWsClient.reconnect();
        }
      });

    this.unsubscribeRequestSettings =
      appEvents.on(
        'requestSettings',
        () => this.sendRequestSettings(),
      );

    this.unsubscribeSubscribeMarketInfo =
      appEvents.on(
        'subscribeMarketInfo',
        () => this.sendSubscribeMarketInfo(),
      );

    this.unsubscribeRequestStorageEntities =
      appEvents.on(
        'requestStorageEntities',
        () => this.sendRequestStorageEntities(),
      );

    this.unsubscribeSettingsChanged =
      appEvents.on('settingsChanged', (settings) => {
        this.scheduleSettingsSave(settings);
      });

    this.unsubscribeRequestMarketStatisticsFullSync =
      appEvents.on(
        'requestMarketStatisticsFullSync',
        (marketName) => this.sendRequestMarketStatisticsFullSync(marketName),
      );

    this.unsubscribeChangeMarketStatisticsSubscription =
      appEvents.on(
        'changeMarketStatisticsSubscription',
        (action, markets) =>
          this.sendChangeMarketStatisticsSubscription(action, markets),
      );

    this.unsubscribeChangeMarketRollingSubscription =
      appEvents.on(
        'changeMarketRollingSubscription',
        (action, markets) =>
          this.sendChangeMarketRollingSubscription(action, markets),
      );

    frontendWsClient.connect();
  }

  public stop(): void {
    this.unsubscribeConnectionState?.();
    this.unsubscribeJsonMessage?.();
    this.unsubscribeBinaryMessage?.();

    this.unsubscribeRequestSettings?.();
    this.unsubscribeSubscribeMarketInfo?.();
    this.unsubscribeRequestStorageEntities?.();
    this.unsubscribeSettingsChanged?.();
    this.unsubscribeRequestMarketStatisticsFullSync?.();
    this.unsubscribeChangeMarketStatisticsSubscription?.();
    this.unsubscribeChangeMarketRollingSubscription?.();

    this.unsubscribeConnectionState = null;
    this.unsubscribeJsonMessage = null;
    this.unsubscribeBinaryMessage = null;

    this.unsubscribeRequestSettings = null;
    this.unsubscribeSubscribeMarketInfo = null;
    this.unsubscribeRequestStorageEntities = null;
    this.unsubscribeSettingsChanged = null;
    this.unsubscribeRequestMarketStatisticsFullSync = null;
    this.unsubscribeChangeMarketStatisticsSubscription = null;
    this.unsubscribeChangeMarketRollingSubscription = null;

    this.clearSettingsSaveTimeout();
    this.clearSessionState();

    frontendWsClient.close();

    this.isStarted = false;
    this.getAppContext = null;
  }

  private sendRequestSettings(): number {
    const clientId = frontendWsClient.createClientId();

    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.requestSettings,
      clientId,
      params: {},
    });

    return clientId;
  }

  private sendSubscribeMarketInfo(): number {
    const clientId =  frontendWsClient.createClientId();

    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.setSubscription,
      clientId,
      params: {
        entity: FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketInfo,
      },
    });

    return clientId;
  }

  private sendRequestStorageEntities(): number {
    const clientId = frontendWsClient.createClientId();

    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.requestStorageEntities,
      clientId,
      params: {},
    });

    return clientId;
  }

  private sendSettingsChanged(settings: FrontendSettings): void {
    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.settingsChanged,
      clientId: frontendWsClient.createClientId(),
      params: { settings: settings.toValue() },
    });
  }

  private sendRequestMarketStatisticsFullSync(marketName: string): number {
    const clientId = frontendWsClient.createClientId();

    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.requestMarketStatisticsFullSync,
      clientId,
      params: { marketName },
    });

    return clientId;
  }

  private sendChangeMarketStatisticsSubscription(
    action: FrontendWsSubscriptionAction,
    markets: string[],
  ): number {
    const clientId = frontendWsClient.createClientId();

    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.changeSubscription,
      clientId,
      params: {
        entity: FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketStatistics,
        action,
        markets,
      },
    });

    return clientId;
  }

  private sendChangeMarketRollingSubscription(
    action: FrontendWsSubscriptionAction,
    markets: string[],
  ): number {
    const clientId = frontendWsClient.createClientId();

    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.changeSubscription,
      clientId,
      params: {
        entity: FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketRolling,
        action,
        markets,
      },
    });

    return clientId;
  }

  private handleBinaryMessage(data: Uint8Array<ArrayBufferLike>): void {
    const transport = decodeCodec(FRONTEND_WS_CODEC, data);

    if (!this.acceptServerId(transport.serverId)) {
      return;
    }

    const binary =
      decodeEntireBinary<StorageBinaryParameters>(transport.data);

    const marketName = binary.parameters?.marketName;

    if (typeof marketName !== 'string') {
      throw new TypeError(
        `Storage binary has invalid marketName: ${String(marketName)}`,
      );
    }

    const predecoded: PredecodedBinary = {
      codecName: binary.codecName,
      data: binary.data,
    };

    if (binary.binaryKind === 'snapshot') {
      appEvents.emit(
        {
          eventName: 'storageSnapshotReceived',
          condition: marketName,
        },
        transport.clientId,
        predecoded,
      );

      return;
    }

    if (binary.binaryKind === 'delta') {
      appEvents.emit(
        {
          eventName: 'storageDeltaReceived',
          condition: marketName,
        },
        transport.clientId,
        predecoded,
      );

      return;
    }

    throw new Error(`Unknown binary kind: ${binary.binaryKind}`);
  }

  private acceptServerId(serverId: number): boolean {
    const expectedServerId = this.lastServerId + 1;

    if (serverId === expectedServerId) {
      this.lastServerId = serverId;
      return true;
    }

    const appContext = this.getCurrentAppContext();

    appContext.logger.error(
      `Frontend WS serverId mismatch: ` +
      `received ${serverId}, expected ${expectedServerId}`,
    );

    this.clearSessionState();
    frontendWsClient.reconnect();

    return false;
  }

  private scheduleSettingsSave(settings: FrontendSettings): void {
    this.lastSettingsToSave =
      FrontendSettings.fromValue(settings.toValue());

    this.clearSettingsSaveTimeout();

    this.settingsSaveTimeoutId = window.setTimeout(
      () => { this.flushSettingsSave(); },
      300,
    );
  }

  private flushSettingsSave(): void {
    if (!this.lastSettingsToSave) {
      return;
    }

    this.sendSettingsChanged(this.lastSettingsToSave);

    this.lastSettingsToSave = null;
    this.clearSettingsSaveTimeout();
  }

  private clearSettingsSaveTimeout(): void {
    if (this.settingsSaveTimeoutId === null) {
      return;
    }

    window.clearTimeout(this.settingsSaveTimeoutId);
    this.settingsSaveTimeoutId = null;
  }

  private shouldLogJsonMessage(type: string): boolean {
    return type !== 'market-rolling-updated';
  }

  private getCurrentAppContext(): AppContextValue {
    if (!this.getAppContext) {
      throw new Error('Frontend WS controller is not started');
    }

    return this.getAppContext();
  }

  private clearSessionState(): void {
    this.lastServerId = 0;
    globalStateService.clearStorageEntities();
    globalStateService.clearMarkets();
  }
}

export const frontendWsController = new FrontendWsController();
