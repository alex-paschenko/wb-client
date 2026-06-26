import { frontendWsClient } from '../api/frontend-ws';
import type {
  AppContextValue,
} from '../contexts/AppContext';
import { appEvents } from '../events/app-events';
import { FrontendSettings } from '../../../shared/services/frontend-settings';
import {
  FRONTEND_WS_CONTROL_MESSAGE_TYPES,
  FRONTEND_WS_SUBSCRIPTION_ENTITIES,
} from '../../../shared/constants/frontend-ws';

type GetAppContext = () => AppContextValue;

type PrimaryDataReceivedState = {
  settings: boolean;
  marketInfo: boolean;
};

const resetPrimaryDataRequestState: () => PrimaryDataReceivedState =
  () => ({
    settings: false,
    marketInfo: false,
  });

export class FrontendWsService {
  private getAppContext: GetAppContext | null = null;
  private isStarted = false;

  private unsubscribeConnectionState: (() => void) | null = null;
  private unsubscribeJsonMessage: (() => void) | null = null;
  private unsubscribeBinaryMessage: (() => void) | null = null;
  private unsubscribeSettingsChanged: (() => void) | null = null;

  private settingsSaveTimeoutId: number | null = null;
  private lastSettingsToSave: FrontendSettings | null = null;

  private dataReceived: PrimaryDataReceivedState =
    resetPrimaryDataRequestState();

  private needsSecondaryDataRequest = true;

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

        if (isConnected) {
          this.dataReceived =resetPrimaryDataRequestState();
          this.needsSecondaryDataRequest = true;
          this.primaryDataRequest();
        }
      });

    this.unsubscribeJsonMessage =
      frontendWsClient.onJsonMessage((message) => {
        const appContext = this.getCurrentAppContext();

        if (this.shouldLogJsonMessage(message.type)) {
          appContext.logger.debug(`log.messages.wsJson.${message.type}`);
        }

        if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.settingsLoaded) {
          const settings = FrontendSettings.fromValue(
            message.params.settings,
          );

          appContext.applySettingsFromServer(settings);
          appContext.logger.debug('log.messages.settingsLoaded');

          this.markPrimaryDataReceived('settings');

          return;
        }

        if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.settingsAccepted) {
          appContext.logger.debug('log.messages.settingsAccepted');
          return;
        }

        if (message.type === FRONTEND_WS_CONTROL_MESSAGE_TYPES.marketsUpdated) {
          appContext.setMarkets(message.markets);
          appContext.logger.debug('log.messages.marketsUpdated');

          this.markPrimaryDataReceived('marketInfo');

          return;
        }
      });

    this.unsubscribeBinaryMessage =
      frontendWsClient.onBinaryMessage(() => {
        const appContext = this.getCurrentAppContext();

        appContext.logger.debug('log.messages.wsBinaryReceived');
      });

    this.unsubscribeSettingsChanged =
      appEvents.on('settingsChanged', (settings) => {
        this.scheduleSettingsSave(settings);
      });

    frontendWsClient.connect();
  }

  public stop(): void {
    this.unsubscribeConnectionState?.();
    this.unsubscribeJsonMessage?.();
    this.unsubscribeBinaryMessage?.();
    this.unsubscribeSettingsChanged?.();

    this.unsubscribeConnectionState = null;
    this.unsubscribeJsonMessage = null;
    this.unsubscribeBinaryMessage = null;
    this.unsubscribeSettingsChanged = null;

    this.clearSettingsSaveTimeout();

    frontendWsClient.close();

    this.isStarted = false;
    this.getAppContext = null;
  }

  public requestSettings(): void {
    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.requestSettings,
      clientId: frontendWsClient.createClientId(),
      params: {},
    });
  }

  public sendSettingsChanged(settings: FrontendSettings): void {
    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.settingsChanged,
      clientId: frontendWsClient.createClientId(),
      params: {
        settings: settings.toValue(),
      },
    });
  }

  private subscribeMarketInfo(): void {
    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.setSubscription,
      clientId: frontendWsClient.createClientId(),
      params: {
        entity: FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketInfo,
      },
    });
  }

  private subscribeMarketStatistics(): void {
    const appContext = this.getCurrentAppContext();
    const markets = appContext.settings.getOpenMarkets();

    frontendWsClient.sendJson({
      type: FRONTEND_WS_CONTROL_MESSAGE_TYPES.setSubscription,
      clientId: frontendWsClient.createClientId(),
      params: {
        entity: FRONTEND_WS_SUBSCRIPTION_ENTITIES.marketStatistics,
        markets,
      },
    });
  }

  private primaryDataRequest(): void {
    this.subscribeMarketInfo();
    this.requestSettings();
  }

  private secondaryDataRequest(): void {
    this.subscribeMarketStatistics();
  }

  private trySecondaryDataRequest(): void {
    if (!this.needsSecondaryDataRequest) {
      return;
    }

    const hasAllPrimaryData = Object.values(this.dataReceived)
      .every(Boolean);

    if (!hasAllPrimaryData) {
      return;
    }

    this.needsSecondaryDataRequest = false;
    this.secondaryDataRequest();
  }

  private markPrimaryDataReceived(
    dataName: keyof PrimaryDataReceivedState,
  ): void {
    this.dataReceived[dataName] = true;
    this.trySecondaryDataRequest();
  }

  private scheduleSettingsSave(settings: FrontendSettings): void {
    this.lastSettingsToSave = FrontendSettings.fromValue(settings.toValue());

    this.clearSettingsSaveTimeout();

    this.settingsSaveTimeoutId = window.setTimeout(() => {
      this.flushSettingsSave();
    }, 300);
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
    if (this.settingsSaveTimeoutId !== null) {
      window.clearTimeout(this.settingsSaveTimeoutId);
      this.settingsSaveTimeoutId = null;
    }
  }

  private shouldLogJsonMessage(type: string): boolean {
    return type !== 'market-rolling-updated';
  }

  private getCurrentAppContext(): AppContextValue {
    if (!this.getAppContext) {
      throw new Error('Frontend WS service is not started');
    }

    return this.getAppContext();
  }
}

export const frontendWsService = new FrontendWsService();
