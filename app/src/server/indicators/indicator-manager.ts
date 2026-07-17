// app/src/server/indicators/indicator-manager.ts
import {
  SERVER_EVENT,
} from '../constants/events.js';
import {
  eventBus,
} from '../services/event-bus.js';
import type {
  RecalculateIndicatorsRequestEvent,
} from '../types/events.js';
import type {
  MarketIndicator,
  MarketIndicatorResultsReader,
} from '../types/market-indicators.js';
import type {
  IndicatorResults,
} from '../../shared/types/market-indicators.js';
import {
  EmaIndicator,
} from './indicators/ema.js';
import {
  RcaIndicator,
} from './indicators/rca.js';

export class IndicatorManager {
  private readonly indicators: MarketIndicator[];

  public constructor() {
    this.indicators = this.sortIndicators(
      this.createIndicators(),
    );
  }

  public start(): void {
    eventBus.emit(
      SERVER_EVENT.marketIndicatorsRegistryReady,
      {
        registry: this.indicators.map((indicator) =>
          indicator.getStorageConfig(),
        ),
      },
    );

    eventBus.on(
      SERVER_EVENT.recalculateIndicatorsRequest,
      (event) => {
        this.handleRecalculateIndicatorsRequest(event);
      },
    );

    eventBus.on(
      SERVER_EVENT.marketRemoved,
      (event) => {
        this.handleMarketRemoved(event.marketName);
      },
    );
  }

  private handleRecalculateIndicatorsRequest(
    event: RecalculateIndicatorsRequestEvent,
  ): void {
    const resultsByName = new Map<string, IndicatorResults>();

    const resultsReader: MarketIndicatorResultsReader = {
      getLast: (name) =>
        resultsByName.get(name)?.lastResult ?? null,

      getRecalculated: (name) =>
        resultsByName.get(name)?.recalculatedValues ?? [],
    };

    const indicatorResults: IndicatorResults[] = [];

    for (const indicator of this.indicators) {
      const result = indicator.calculate({
        ...event,
        results: resultsReader,
      });

      resultsByName.set(
        indicator.name,
        result,
      );

      indicatorResults.push(result);
    }

    eventBus.emit(
      SERVER_EVENT.recalculateIndicatorsResults,
      {
        marketName: event.marketName,
        receivedAt: event.receivedAt,
        numOfAffectedLevels: event.numOfAffectedLevels,
        indicators: indicatorResults,
      },
    );
  }

  private handleMarketRemoved(
    marketName: string,
  ): void {
    for (const indicator of this.indicators) {
      indicator.removeMarket(marketName);
    }
  }

  private createIndicators(): MarketIndicator[] {
    const periods = [20, 50, 90, 200];

    return [
      ...periods.map(
        (period) => new RcaIndicator({ period }),
      ),
      ...periods.map(
        (period) => new EmaIndicator({ period }),
      ),
    ];
  }

  private sortIndicators(
    indicators: MarketIndicator[],
  ): MarketIndicator[] {
    const sorted: MarketIndicator[] = [];
    const permanent = new Set<string>();
    const temporary = new Set<string>();

    const byName = new Map(
      indicators.map((indicator) => [
        indicator.name,
        indicator,
      ]),
    );

    const visit = (
      indicator: MarketIndicator,
    ): void => {
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
        const dependencyIndicator =
          byName.get(dependency);

        if (!dependencyIndicator) {
          throw new Error(
            `Indicator ${indicator.name} depends on ` +
            `unknown indicator ${dependency}`,
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

export const indicatorManager =
  new IndicatorManager();

