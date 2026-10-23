import {
  CANDLE_NAME,
  MARKET_FORECAST_NAME,
} from '../../shared/constants/storage-entities.js';
import { MINUTES } from '../../shared/constants/time.js';
import type {
  MarketCandle,
  MarketForecastValue,
} from '../../shared/types/data-types.js';
import type { LazyArray } from '../../shared/utilities/lazy-array.js';
import { SERVER_EVENT } from '../constants/events.js';
import { strategies } from '../strategies/index.js';
import type { RunStrategiesRequestEvent } from '../types/events.js';
import type { OrderBookDepth } from '../types/order-book-depth.js';
import type {
  Strategy,
  StrategyStateChange,
  StrategyStorage,
} from '../types/strategies.js';
import { eventBus } from './event-bus.js';
import { orderBookDepthService } from './order-book-depth.js';
import { orderManager } from './order-manager.js';

type StateHistory = Map<Strategy, StrategyStateChange<string>[]>;

export class StrategyManager {
  private readonly storageByMarkets = new Map<string, StrategyStorage[]>();

  private readonly stateHistoryByMarkets = new Map<string, StateHistory>();

  private readonly unsubscribe: (() => void)[] = [];

  private stateTimer: ReturnType<typeof setInterval> | null = null;

  public constructor(
    private readonly strategies: Strategy<any>[],
  ) {}

  public start(): void {
    if (this.unsubscribe.length > 0) return;
    this.unsubscribe.push(eventBus.on(
      SERVER_EVENT.runStrategiesRequest,
      (event) => this.handleRunStrategiesRequest(event),
    ));

    this.unsubscribe.push(orderBookDepthService.addListener(
      (strategy, marketName, depthHistory) => {
        this.runOnChange(strategy, marketName, depthHistory);
      },
    ));

    this.unsubscribe.push(orderManager.addListener(
      (marketName, strategy) => {
        this.runOnChange(
          strategy, marketName, orderBookDepthService.getHistory(marketName),
        );
      },
    ));

    this.stateTimer = setInterval(
      () => this.saveStateHistory(false),
      5 * MINUTES,
    );
  }

  public stop(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) {
      unsubscribe();
    }

    if (this.stateTimer) {
      clearInterval(this.stateTimer);
    }

    this.stateTimer = null;
    this.saveStateHistory(true);
  }

  private handleRunStrategiesRequest(
    event: RunStrategiesRequestEvent,
  ): void {
    const { marketName, accessors, size, endedAt } = event;
    try {
      const last = size - 1;

      const forecast =
        (accessors.indicators[MARKET_FORECAST_NAME] as LazyArray<MarketForecastValue>)
          .get(last);

      const price = (accessors.candles[CANDLE_NAME] as LazyArray<MarketCandle>)
        .get(last, 'price');

      const storage = [{ marketName, receivedAt: endedAt, price, forecast }];
      this.storageByMarkets.set(marketName, storage);

      orderManager.setReceivedAt(marketName, endedAt);
      orderBookDepthService.setReceivedAt(marketName, endedAt);

      for (const strategy of this.strategies) {
        this.runStrategy(
          strategy,
          marketName,
          orderBookDepthService.getHistory(marketName),
        );
      }

      eventBus.emit(
        SERVER_EVENT.strategiesCompleted,
        { marketName, size, endedAt },
      );
    } catch (error) {
      eventBus.emit(
        SERVER_EVENT.strategiesCompleted,
        { marketName, size, endedAt, error },
      );
    }
  }

  private runOnChange(
    strategy: Strategy,
    marketName: string,
    depthHistory: OrderBookDepth[] | null,
  ): void {
    if (!this.storageByMarkets.has(marketName)) {
      return;
    }

    try {
      this.runStrategy(strategy, marketName, depthHistory);
    } catch (error) {
      console.error('Strategy failed on asynchronous update', {
        marketName, strategy: strategy.name, error,
      });
    }
  }

  private runStrategy(
    strategy: Strategy,
    marketName: string,
    depthHistory: OrderBookDepth[] | null,
  ): void {
    const storage = this.storageByMarkets.get(marketName);

    if (!storage) {
      throw new Error('Missing storage for ' + marketName);
    }

    let states = this.stateHistoryByMarkets.get(marketName);
    if (!states) {
      states = new Map();
      this.stateHistoryByMarkets.set(marketName, states);
    }

    let stateChanges = states.get(strategy);
    if (!stateChanges) {
      stateChanges = [];
      states.set(strategy, stateChanges);
    }

    strategy.run({
      storage,
      orderApi: orderManager.api,
      depthApi: orderBookDepthService.api,
      stateChanges,
      depthHistory,
      orders: orderManager.getOrdersForStrategy(marketName, strategy),
    });
  }

  private saveStateHistory(includeLast: boolean): void {
    const changes = [];
    for (const [marketName, strategies] of this.stateHistoryByMarkets) {
      for (const [strategy, history] of strategies) {
        const count = includeLast ? history.length : history.length - 1;

        if (count <= 0) {
          continue;
        }

        for (const change of history.slice(0, count)) {
          changes.push({
            ...change,
            marketName,
            strategyName: strategy.name,
          });
        }

        history.splice(0, count);
      }
    }

    if (changes.length > 0) {
      eventBus.emit(
        SERVER_EVENT.strategyStatePersistenceRequest,
        { changes },
      );
    }
  }
}

export const strategyManager = new StrategyManager(strategies);
