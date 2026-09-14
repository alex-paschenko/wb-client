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
import type { FrontendWsSubscriptionAction } from
  '../../../shared/types/frontend-ws';
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
          this.lastServerId = 0;
          globalStateService.clearStorageEntities();
          globalStateService.clearMarkets();
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
          globalStateService.addStorageEntities(message.params.entities);

          appContext.logger.debug(
            'log.messages.storageEntitiesLoaded',
          );

          appEvents.emit(
            'startupStorageEntitiesReceived',
            message.params.entities,
          );
        }
      });

    this.unsubscribeBinaryMessage =
      frontendWsClient.onBinaryMessage((data) => {
        this.handleBinaryMessage(data);
      });

    this.unsubscribeRequestSettings =
      appEvents.on('requestSettings', () => {
        this.sendRequestSettings();
      });

    this.unsubscribeSubscribeMarketInfo =
      appEvents.on('subscribeMarketInfo', () => {
        this.sendSubscribeMarketInfo();
      });

    this.unsubscribeRequestStorageEntities =
      appEvents.on('requestStorageEntities', () => {
        this.sendRequestStorageEntities();
      });

    this.unsubscribeSettingsChanged =
      appEvents.on('settingsChanged', (settings) => {
        this.scheduleSettingsSave(settings);
      });

    this.unsubscribeRequestMarketStatisticsFullSync =
      appEvents.on(
        'requestMarketStatisticsFullSync',
        (marketName) => {
          this.sendRequestMarketStatisticsFullSync(marketName);
        },
      );

    this.unsubscribeChangeMarketStatisticsSubscription =
      appEvents.on(
        'changeMarketStatisticsSubscription',
        (action, markets) => {
          this.sendChangeMarketStatisticsSubscription(action, markets);
        },
      );

    this.unsubscribeChangeMarketRollingSubscription =
      appEvents.on(
        'changeMarketRollingSubscription',
        (action, markets) => {
          this.sendChangeMarketRollingSubscription(action, markets);
        },
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

    this.lastServerId = 0;

    frontendWsClient.close();

    this.isStarted = false;
    this.getAppContext = null;
  }

  private sendRequestSettings(): void {
    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.requestSettings,
      clientId: frontendWsClient.createClientId(),
      params: {},
    });
  }

  private sendSubscribeMarketInfo(): void {
    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.setSubscription,
      clientId: frontendWsClient.createClientId(),
      params: {
        entity: FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketInfo,
      },
    });
  }

  private sendRequestStorageEntities(): void {
    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.requestStorageEntities,
      clientId: frontendWsClient.createClientId(),
      params: {},
    });
  }

  private sendSettingsChanged(settings: FrontendSettings): void {
    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.settingsChanged,
      clientId: frontendWsClient.createClientId(),
      params: { settings: settings.toValue() },
    });
  }

  private sendRequestMarketStatisticsFullSync(marketName: string): void {
    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.requestMarketStatisticsFullSync,
      clientId: frontendWsClient.createClientId(),
      params: { marketName },
    });
  }

  private sendChangeMarketStatisticsSubscription(
    action: FrontendWsSubscriptionAction,
    markets: string[],
  ): void {
    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.changeSubscription,
      clientId: frontendWsClient.createClientId(),
      params: {
        entity: FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketStatistics,
        action,
        markets,
      },
    });
  }

  private sendChangeMarketRollingSubscription(
    action: FrontendWsSubscriptionAction,
    markets: string[],
  ): void {
    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.changeSubscription,
      clientId: frontendWsClient.createClientId(),
      params: {
        entity: FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketRolling,
        action,
        markets,
      },
    });
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

    this.lastServerId = 0;
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
}

export const frontendWsController = new FrontendWsController();
