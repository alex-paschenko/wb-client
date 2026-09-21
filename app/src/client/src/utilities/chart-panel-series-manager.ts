// app/src/client/src/utilities/chart-panel-series-manager.ts

import {
  CandlestickSeries,
  LineSeries,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type SeriesType,
  type WhitespaceData,
} from 'lightweight-charts';

import type { MarketCandle } from '../../../shared/types/data-types';
import type { StorageAccessors } from '../../../shared/types/storage';
import type {
  EntityDataDescriptor,
  EntityDesriptor,
  LineDataDescriptor,
} from '../../../shared/types/storage-entities';
import type { LazyArray } from '../../../shared/utilities/lazy-array';
import type {
  MarketChartUpdateMode,
} from '../controllers/MarketStatisticsView';
import type {
  LineEntitySettings,
  OhlcEntitySettings,
} from '../entity-data/types';
import {
  getEntityChartTime,
} from '../entity-data/utilities';

type LinePoint = LineData | WhitespaceData;

type ChartPanelSeriesSettings =
  | LineEntitySettings
  | OhlcEntitySettings;

export interface ChartPanelSeries {
  key: string;
  title: string;
  descriptor: EntityDesriptor;
  dataDescriptor: EntityDataDescriptor;
  settings: ChartPanelSeriesSettings;
}

export interface ChartPanelSeriesSyncContext {
  accessors: StorageAccessors;
  startIndex: number;
  endIndex: number;
  updateMode: MarketChartUpdateMode;
}

interface ManagedChartPanelSeries {
  series: ISeriesApi<SeriesType>;
  isInitialized: boolean;
}

export class ChartPanelSeriesManager {
  private readonly seriesByKey =
    new Map<string, ManagedChartPanelSeries>();

  public constructor(
    private readonly chart: IChartApi,
    private panelIndex: number,
  ) {}

  public sync(
    panelSeries: readonly ChartPanelSeries[],
    context: ChartPanelSeriesSyncContext,
  ): void {
    const activeKeys = new Set(
      panelSeries.map((item) => item.key),
    );

    this.removeInactiveSeries(activeKeys);

    for (const item of panelSeries) {
      const managed = this.getOrCreateSeries(item);

      this.applySettings(
        managed.series,
        item,
      );

      if (
        !managed.isInitialized ||
        context.updateMode === 'replace'
      ) {
        this.replaceSeriesData(
          managed,
          item,
          context,
        );

        continue;
      }

      this.appendSeriesData(
        managed,
        item,
        context,
      );
    }
  }

  public moveToPanel(panelIndex: number): void {
    if (this.panelIndex === panelIndex) {
      return;
    }

    this.panelIndex = panelIndex;

    for (const managed of this.seriesByKey.values()) {
      managed.series.moveToPane(panelIndex);
    }
  }

  public dispose(): void {
    for (const managed of this.seriesByKey.values()) {
      this.chart.removeSeries(managed.series);
    }

    this.seriesByKey.clear();
  }

  private replaceSeriesData(
    managed: ManagedChartPanelSeries,
    item: ChartPanelSeries,
    context: ChartPanelSeriesSyncContext,
  ): void {
    switch (item.dataDescriptor.kind) {
      case 'line': {
        const series =
          managed.series as ISeriesApi<'Line'>;

        const data: LinePoint[] = [];

        for (
          let index = context.startIndex;
          index <= context.endIndex;
          index++
        ) {
          data.push(
            this.getLineData(
              item,
              item.dataDescriptor,
              context.accessors,
              index,
            ),
          );
        }

        series.setData(data);
        break;
      }

      case 'ohlc': {
        const series =
          managed.series as ISeriesApi<'Candlestick'>;

        const data: CandlestickData[] = [];

        for (
          let index = context.startIndex;
          index <= context.endIndex;
          index++
        ) {
          data.push(
            this.getOhlcData(
              item,
              context.accessors,
              index,
            ),
          );
        }

        series.setData(data);
        break;
      }
    }

    managed.isInitialized = true;
  }

  private appendSeriesData(
    managed: ManagedChartPanelSeries,
    item: ChartPanelSeries,
    context: ChartPanelSeriesSyncContext,
  ): void {
    if (context.endIndex < 0) {
      return;
    }

    switch (item.dataDescriptor.kind) {
      case 'line': {
        const series =
          managed.series as ISeriesApi<'Line'>;

        series.update(
          this.getLineData(
            item,
            item.dataDescriptor,
            context.accessors,
            context.endIndex,
          ),
        );

        break;
      }

      case 'ohlc': {
        const series =
          managed.series as ISeriesApi<'Candlestick'>;

        series.update(
          this.getOhlcData(
            item,
            context.accessors,
            context.endIndex,
          ),
        );

        break;
      }
    }
  }

  private getLineData(
    item: ChartPanelSeries,
    dataDescriptor: LineDataDescriptor,
    accessors: StorageAccessors,
    index: number,
  ): LinePoint {
    const accessor =
      accessors[item.descriptor.kind][item.descriptor.name] as
        LazyArray<unknown>;

    if (!accessor) {
      throw new Error(
        `Accessor "${item.descriptor.kind}/` +
        `${item.descriptor.name}" not found`,
      );
    }

    const time =
      getEntityChartTime(accessors, index);

    const value = dataDescriptor.key
      ? accessor.get(index, dataDescriptor.key as never)
      : accessor.get(index);

    if (value === null) {
      return { time };
    }

    if (typeof value !== 'number') {
      throw new TypeError(
        'Line data must be a number or null: ' +
        `${item.descriptor.kind}/${item.descriptor.name}` +
        (
          dataDescriptor.key
            ? `.${dataDescriptor.key}`
            : ''
        ),
      );
    }

    return {
      time,
      value,
    };
  }

  private getOhlcData(
    item: ChartPanelSeries,
    accessors: StorageAccessors,
    index: number,
  ): CandlestickData {
    const accessor =
      accessors[item.descriptor.kind][item.descriptor.name] as
        LazyArray<MarketCandle>;

    if (!accessor) {
      throw new Error(
        `Accessor "${item.descriptor.kind}/` +
        `${item.descriptor.name}" not found`,
      );
    }

    return {
      time: getEntityChartTime(accessors, index),
      open: accessor.get(index, 'open'),
      high: accessor.get(index, 'high'),
      low: accessor.get(index, 'low'),
      close: accessor.get(index, 'close'),
    };
  }

  private applySettings(
    series: ISeriesApi<SeriesType>,
    item: ChartPanelSeries,
  ): void {
    switch (item.dataDescriptor.kind) {
      case 'line': {
        const settings =
          item.settings as LineEntitySettings;

        (series as ISeriesApi<'Line'>).applyOptions({
          color: settings.color,
          visible: settings.isVisible,
        });

        break;
      }

      case 'ohlc': {
        const settings =
          item.settings as OhlcEntitySettings;

        (series as ISeriesApi<'Candlestick'>).applyOptions({
          visible: settings.isVisible,
        });

        break;
      }
    }
  }

  private removeInactiveSeries(
    activeKeys: ReadonlySet<string>,
  ): void {
    for (const [key, managed] of this.seriesByKey) {
      if (activeKeys.has(key)) {
        continue;
      }

      this.chart.removeSeries(managed.series);
      this.seriesByKey.delete(key);
    }
  }

  private getOrCreateSeries(
    item: ChartPanelSeries,
  ): ManagedChartPanelSeries {
    const existing = this.seriesByKey.get(item.key);

    if (existing) {
      return existing;
    }

    let series: ISeriesApi<SeriesType>;

    switch (item.dataDescriptor.kind) {
      case 'line': {
        const settings =
          item.settings as LineEntitySettings;

        const isPrice =
          item.dataDescriptor.style === 'price';

        series = this.chart.addSeries(
          LineSeries,
          {
            title: item.title,
            color: settings.color,
            lineWidth: isPrice ? 3 : 1,
            visible: settings.isVisible,
            priceLineVisible: isPrice,
            lastValueVisible: true,
          },
          this.panelIndex,
        );

        break;
      }

      case 'ohlc': {
        const settings =
          item.settings as OhlcEntitySettings;

        series = this.chart.addSeries(
          CandlestickSeries,
          {
            visible: settings.isVisible,
            priceLineVisible: false,
            lastValueVisible: false,
          },
          this.panelIndex,
        );

        break;
      }
    }

    const managed: ManagedChartPanelSeries = {
      series,
      isInitialized: false,
    };

    this.seriesByKey.set(
      item.key,
      managed,
    );

    return managed;
  }
}
