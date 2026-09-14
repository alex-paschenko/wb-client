// app/src/server/services/global-state.ts

import { globalStateService } from '../../shared/services/global-state.js';
import { SERVER_EVENT } from '../constants/events.js';
import { eventBus } from './event-bus.js';

export class ServerGlobalStateService {
  private unsubscribeStorageEntities:
    (() => void) | null = null;

  private unsubscribeMarkets:
    (() => void) | null = null;

  public start(): void {
    if (
      this.unsubscribeStorageEntities ||
      this.unsubscribeMarkets
    ) {
      return;
    }

    this.unsubscribeMarkets = eventBus.on(
      SERVER_EVENT.marketsInfoUpdated,
      (event) => globalStateService.setMarkets(event.markets, event.marketNames),
    );

    this.unsubscribeStorageEntities = eventBus.on(
      SERVER_EVENT.addStorageEntities,
      (event) => { globalStateService.addStorageEntities(event.entities); },
    );
  }

  public stop(): void {
    this.unsubscribeStorageEntities?.();
    this.unsubscribeMarkets?.();

    this.unsubscribeStorageEntities = null;
    this.unsubscribeMarkets = null;
  }
}

export const serverGlobalStateService = new ServerGlobalStateService();
