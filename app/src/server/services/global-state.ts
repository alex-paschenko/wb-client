// app/src/server/services/global-state.ts
import {
  globalStateService,
} from '../../shared/services/global-state.js';
import {
  SERVER_EVENT,
} from '../constants/events.js';
import {
  eventBus,
} from './event-bus.js';

export class ServerGlobalStateService {
  private unsubscribeIndicatorRegistry:
    (() => void) | null = null;

  private unsubscribeMarkets:
    (() => void) | null = null;

  public start(): void {
    if (
      this.unsubscribeIndicatorRegistry ||
      this.unsubscribeMarkets
    ) {
      return;
    }

    this.unsubscribeMarkets = eventBus.on(
      SERVER_EVENT.marketsInfoUpdated,
      (event) =>
        globalStateService.setMarkets(event.markets, event.marketNames),
    );

    this.unsubscribeIndicatorRegistry = eventBus.on(
      SERVER_EVENT.marketIndicatorsRegistryReady,
      (event) => {
        globalStateService.setIndicatorRegistry(event.registry);
      },
    );
  }

  public stop(): void {
    this.unsubscribeIndicatorRegistry?.();
    this.unsubscribeMarkets?.();

    this.unsubscribeIndicatorRegistry = null;
    this.unsubscribeMarkets = null;
  }
}

export const serverGlobalStateService =
  new ServerGlobalStateService();
