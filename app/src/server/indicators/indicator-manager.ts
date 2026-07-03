// app/src/server/indicators/indicator-manager.ts

import { SERVER_EVENT } from '../constants/events.js';
import type {
  MarketIndicator,
  MarketIndicatorResultsReader,
} from '../types/market-indicators.js';
import { eventBus } from '../services/event-bus.js';
import { EmaIndicator } from './indicators/ema.js';
import { RcaIndicator } from './indicators/rca.js';
import { MarketStatisticsStorageUpdatedEvent } from '../types/events.js';

export class IndicatorManager {
  private readonly indicators: MarketIndicator[];

  public constructor() {
    this.indicators = this.sortIndicators(
      this.createIndicators(),
    );
  }

  public start(): void {
    eventBus.on(
      SERVER_EVENT.marketStatisticsStorageUpdated,
      (event) => {
        this.handleStorageUpdated(event);
      },
    );

    eventBus.on(
      SERVER_EVENT.marketRemoved,
      (event) => {
        this.handleMarketRemoved(event.marketName);
      },
    );
  }

  private handleStorageUpdated(
    event: MarketStatisticsStorageUpdatedEvent,
  ): void {
    const mutableResults: Record<string, number> = {};

    const resultsReader: MarketIndicatorResultsReader = {
      get: (name) => mutableResults[name] ?? null,
    };

    for (const indicator of this.indicators) {
      const value = indicator.calculate({
        marketName: event.marketName,
        candles: event.candles,
        reversedCandles: event.reversedCandles,
        results: resultsReader,
      });

      if (value === null) {
        delete mutableResults[indicator.name];
        continue;
      }

      mutableResults[indicator.name] = value;
    }

    eventBus.emit(SERVER_EVENT.marketIndicatorsUpdated, {
      marketName: event.marketName,
      indicators: Object.freeze({ ...mutableResults }),
    });
  }

  private handleMarketRemoved(marketName: string): void {
    for (const indicator of this.indicators) {
      indicator.removeMarket(marketName);
    }
  }

  private createIndicators(): MarketIndicator[] {
    const periods = [20, 50, 90, 200];

    return [
      ...periods.map((period) => new RcaIndicator({ period })),
      ...periods.map((period) => new EmaIndicator({ period })),
    ];
  }

  private sortIndicators(
    indicators: MarketIndicator[],
  ): MarketIndicator[] {
    const sorted: MarketIndicator[] = [];
    const permanent = new Set<string>();
    const temporary = new Set<string>();

    const byName = new Map(
      indicators.map((indicator) => [indicator.name, indicator]),
    );

    const visit = (indicator: MarketIndicator): void => {
      if (permanent.has(indicator.name)) {
        return;
      }

      if (temporary.has(indicator.name)) {
        throw new Error(
          `Circular indicator dependency: ${indicator.name}`,
        );
      }

      temporary.add(indicator.name);

      for (const dependency of indicator.dependencies) {
        const dependencyIndicator = byName.get(dependency);

        if (!dependencyIndicator) {
          throw new Error(
            `Indicator ${indicator.name} depends on unknown indicator ${dependency}`,
          );
        }

        visit(dependencyIndicator);
      }

      temporary.delete(indicator.name);
      permanent.add(indicator.name);
      sorted.push(indicator);
    };

    for (const indicator of indicators) {
      visit(indicator);
    }

    return sorted;
  }
}

export const indicatorManager = new IndicatorManager();
