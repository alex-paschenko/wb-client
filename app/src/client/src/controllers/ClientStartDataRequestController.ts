import { frontendWsClient } from '../api/frontend-ws';
import {
  FRONTEND_WS_CONTROL_MESSAGE_TYPES,
  FRONTEND_WS_SUBSCRIPTION_ENTITIES,
} from '../../../shared/constants/frontend-ws';

export type PrimaryStartDataName =
  | 'settings'
  | 'marketInfo';

type PrimaryDataReceivedState = Record<PrimaryStartDataName, boolean>;

const resetPrimaryDataRequestState = (): PrimaryDataReceivedState => ({
  settings: false,
  marketInfo: false,
});

export class ClientStartDataRequestController {
  private dataReceived = resetPrimaryDataRequestState();
  private needsSecondaryDataRequest = true;

  public reset(): void {
    this.dataReceived = resetPrimaryDataRequestState();
    this.needsSecondaryDataRequest = true;
  }

  public requestPrimaryData(): void {
    this.sendSubscribeMarketInfo();
    this.sendRequestSettings();
  }

  public markPrimaryDataReceived(dataName: PrimaryStartDataName): void {
    this.dataReceived[dataName] = true;
    this.tryRequestSecondaryData();
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

  private tryRequestSecondaryData(): void {
    if (!this.needsSecondaryDataRequest) {
      return;
    }

    const hasAllPrimaryData = Object.values(this.dataReceived)
      .every(Boolean);

    if (!hasAllPrimaryData) {
      return;
    }

    this.needsSecondaryDataRequest = false;
    this.requestSecondaryData();
  }

  private requestSecondaryData(): void {
    console.log('Secondary data request');
    // Request market and settings dependent data.
  }
}

export const clientStartDataRequestController =
  new ClientStartDataRequestController();
