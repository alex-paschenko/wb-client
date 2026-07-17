// app/src/client/src/controllers/ClientStartDataRequestController.ts
import {
  FRONTEND_WS_CONTROL_MESSAGE_TYPES,
  FRONTEND_WS_SUBSCRIPTION_ENTITIES,
} from '../../../shared/constants/frontend-ws';
import {
  frontendWsClient,
} from '../api/frontend-ws';
import {
  BaseController,
} from './BaseController';

export type PrimaryStartDataName =
  | 'settings'
  | 'marketInfo'
  | 'marketIndicatorsRegistry';

type PrimaryDataReceivedState =
  Record<PrimaryStartDataName, boolean>;

export interface ClientStartDataRequestControllerState {
  isPrimaryDataReady: boolean;
  isSecondaryDataRequested: boolean;
}

const createInitialState =
  (): ClientStartDataRequestControllerState => ({
    isPrimaryDataReady: false,
    isSecondaryDataRequested: false,
  });

const resetPrimaryDataReceivedState =
  (): PrimaryDataReceivedState => ({
    settings: false,
    marketInfo: false,
    marketIndicatorsRegistry: false,
  });

export class ClientStartDataRequestController
  extends BaseController<ClientStartDataRequestControllerState> {
  private dataReceived =
    resetPrimaryDataReceivedState();

  private needsSecondaryDataRequest = true;

  public constructor() {
    super(createInitialState());
  }

  public reset(): void {
    this.dataReceived =
      resetPrimaryDataReceivedState();

    this.needsSecondaryDataRequest = true;

    this.setState(
      createInitialState(),
    );
  }

  public requestPrimaryData(): void {
    this.sendSubscribeMarketInfo();
    this.sendRequestSettings();
    this.sendRequestMarketIndicatorsRegistry();
  }

  public markPrimaryDataReceived(
    dataName: PrimaryStartDataName,
  ): void {
    this.dataReceived[dataName] = true;

    this.tryRequestSecondaryData();
  }

  private sendRequestSettings(): void {
    frontendWsClient.sendJson({
      type:
        FRONTEND_WS_CONTROL_MESSAGE_TYPES
          .requestSettings,
      clientId:
        frontendWsClient.createClientId(),
      params: {},
    });
  }

  private sendSubscribeMarketInfo(): void {
    frontendWsClient.sendJson({
      type:
        FRONTEND_WS_CONTROL_MESSAGE_TYPES
          .setSubscription,
      clientId:
        frontendWsClient.createClientId(),
      params: {
        entity:
          FRONTEND_WS_SUBSCRIPTION_ENTITIES
            .marketInfo,
      },
    });
  }

  private sendRequestMarketIndicatorsRegistry(): void {
    frontendWsClient.sendJson({
      type:
        FRONTEND_WS_CONTROL_MESSAGE_TYPES
          .requestMarketIndicatorsRegistry,
      clientId:
        frontendWsClient.createClientId(),
      params: {},
    });
  }

  private tryRequestSecondaryData(): void {
    if (!this.needsSecondaryDataRequest) {
      return;
    }

    const hasAllPrimaryData =
      Object.values(this.dataReceived)
        .every(Boolean);

    if (!hasAllPrimaryData) {
      return;
    }

    this.needsSecondaryDataRequest = false;

    this.patchState({
      isPrimaryDataReady: true,
    });

    this.requestSecondaryData();

    this.patchState({
      isSecondaryDataRequested: true,
    });
  }

  private requestSecondaryData(): void {
    /*
     * Request data that depends on settings, market info,
     * and the indicator registry.
     *
     * Individual MarketView components request their own
     * market statistics full sync after they are mounted.
     */
  }
}

export const clientStartDataRequestController =
  new ClientStartDataRequestController();
