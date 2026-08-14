// app/src/client/src/controllers/MarketStatisticsView.ts

import type {
  CandlestickData,
  LineData,
  UTCTimestamp,
  WhitespaceData,
} from 'lightweight-charts';

import {
  MARKET_STATISTICS_LEVEL_DURATIONS,
} from '../../../shared/constants/market-statistics-config';
import { SECOND } from '../../../shared/constants/time';
import {
  MarketStatisticsStorageService,
} from '../../../shared/services/market-statistics-storage';
import type {
  MarketIndicatorValues,
} from '../../../shared/types/market-indicators';
import type {
  MarketCandle,
} from '../../../shared/types/market-statistics-storage';
import type {
  FullMarketStatisticsPayload,
  MarketStatisticsBinaryPayload,
} from '../../../shared/utilities/market-statistics-payload-codec';

export type MarketChartLinePoint = LineData | WhitespaceData;

export type MarketChartCandlePoint = CandlestickData;

export interface MarketChartIndicatorData {
  indicatorName: string;
  data: MarketChartLinePoint[];
}

export type MarketChartVisibleRange = {
  from: UTCTimestamp;
  to: UTCTimestamp;
};

export interface MarketStatisticsViewState {
  pointsCount: number;
  chartVersion: number;
  selectedInterval: number;
  candleData: MarketChartCandlePoint[];
  indicatorData: MarketChartIndicatorData[];
  visibleRange: MarketChartVisibleRange;
}

const defaultInterval =
  MARKET_STATISTICS_LEVEL_DURATIONS[0].interval;

const ONE_SECOND = 1 * SECOND;

const createVisibleRange = (
  interval: number,
): MarketChartVisibleRange => {
  const now = Date.now();

  return {
    from: Math.floor((now - interval) / ONE_SECOND) as UTCTimestamp,
    to: Math.floor(now / ONE_SECOND) as UTCTimestamp,
  };
};

export const createInitialMarketStatisticsViewState = (
  interval: number = defaultInterval,
): MarketStatisticsViewState => ({
  pointsCount: 0,
  chartVersion: 0,
  selectedInterval: interval,
  candleData: [],
  indicatorData: [],
  visibleRange: createVisibleRange(interval),
});

export class MarketStatisticsView {
  private storage: MarketStatisticsStorageService | null = null;

  private state: MarketStatisticsViewState;

  public constructor(
    private readonly marketName: string,
    private interval: number = defaultInterval,
  ) {
    this.state = createInitialMarketStatisticsViewState(interval);
  }

  public getState(): MarketStatisticsViewState {
    return this.state;
  }

  public setInterval(
    interval: number,
  ): MarketStatisticsViewState {
    this.interval = interval;

    return this.refresh();
  }

  public applyFullSync(
    payload: FullMarketStatisticsPayload,
  ): MarketStatisticsViewState {
    this.checkPayloadMarketName(payload.marketName);

    const storage = new MarketStatisticsStorageService(this.marketName);

    storage.restoreAllItemsByLevel(payload.levels);

    this.storage = storage;

    return this.refresh();
  }

  public applyDelta(
    payload: MarketStatisticsBinaryPayload,
  ): MarketStatisticsViewState {
    this.checkPayloadMarketName(payload.marketName);

    if (!this.storage) {
      return this.refresh();
    }

    this.storage.applyDelta(payload.payload);

    return this.refresh();
  }

  public applyIndicatorChanges(
    payload: MarketStatisticsBinaryPayload,
  ): MarketStatisticsViewState {
    this.checkPayloadMarketName(payload.marketName);

    if (!this.storage) {
      return this.refresh();
    }

    this.storage.applyIndicatorChanges(payload.payload);

    return this.refresh();
  }

  public refresh(): MarketStatisticsViewState {
    const now = Date.now();
    const visibleRange = createVisibleRange(this.interval);

    if (!this.storage) {
      this.state = {
        ...this.state,
        selectedInterval: this.interval,
        visibleRange,
      };

      return this.state;
    }

    const projection =
      this.storage.createIntervalProjection(this.interval, now);

    if (projection.candles.length !== projection.indicators.length) {
      throw new Error(
        `Cannot create market statistics view for ` +
        `"${this.marketName}": candle count ` +
        `${projection.candles.length} does not match ` +
        `indicator values count ${projection.indicators.length}`,
      );
    }

    const candleData = this.createCandleData(projection.candles);

    const indicatorData = this.createIndicatorsData(
      projection.candles,
      projection.indicators,
    );

    this.state = {
      ...this.state,
      pointsCount: candleData.length,
      chartVersion: this.state.chartVersion + 1,
      selectedInterval: this.interval,
      candleData,
      indicatorData,
      visibleRange,
    };

    return this.state;
  }

  private checkPayloadMarketName(marketName: string): void {
    if (marketName !== this.marketName) {
      throw new Error(
        `Cannot apply market statistics for market ` +
        `"${marketName}" to view "${this.marketName}"`,
      );
    }
  }

  private createCandleData(
    candles: readonly MarketCandle[],
  ): MarketChartCandlePoint[] {
    const dataByTime =
      new Map<UTCTimestamp, MarketChartCandlePoint>();

    for (const candle of candles) {
      const time = this.toChartTime(candle.startedAt);

      dataByTime.set(time, {
        time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      });
    }

    return Array.from(dataByTime.values()).sort(
      (left, right) => Number(left.time) - Number(right.time),
    );
  }

  private createIndicatorsData(
    candles: readonly MarketCandle[],
    indicators: readonly MarketIndicatorValues[],
  ): MarketChartIndicatorData[] {
    const indicatorNames =
      this.getSortedIndicatorNames(indicators);

    return indicatorNames.map((indicatorName) => ({
      indicatorName,
      data: this.createIndicatorData(
        indicatorName,
        candles,
        indicators,
      ),
    }));
  }

  private getSortedIndicatorNames(
    indicators: readonly MarketIndicatorValues[],
  ): string[] {
    const indicatorNames = new Set<string>();

    for (const indicatorValues of indicators) {
      for (const indicatorName of Object.keys(indicatorValues)) {
        indicatorNames.add(indicatorName);
      }
    }

    return Array.from(indicatorNames).sort();
  }

  private createIndicatorData(
    indicatorName: string,
    candles: readonly MarketCandle[],
    indicators: readonly MarketIndicatorValues[],
  ): MarketChartLinePoint[] {
    const dataByTime =
      new Map<UTCTimestamp, MarketChartLinePoint>();

    for (let index = 0; index < candles.length; index += 1) {
      const candle = candles[index];
      const indicatorValues = indicators[index];

      if (!candle || !indicatorValues) {
        throw new Error(
          `Cannot create indicator data ` +
          `"${indicatorName}" for market ` +
          `"${this.marketName}": missing data ` +
          `at projection index ${index}`,
        );
      }

      const time = this.toChartTime(candle.startedAt);
      const value = indicatorValues[indicatorName];

      dataByTime.set(
        time,
        value === null || value === undefined
          ? { time }
          : { time, value },
      );
    }

    return Array.from(dataByTime.values()).sort(
      (left, right) => Number(left.time) - Number(right.time),
    );
  }

  private toChartTime(timestamp: number): UTCTimestamp {
    return Math.floor(timestamp / ONE_SECOND) as UTCTimestamp;
  }
}
