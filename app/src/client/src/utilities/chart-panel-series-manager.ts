// app/src/client/src/utilities/chart-panel-series-manager.ts

import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';

import type { StorageAccessors } from '../../../shared/types/storage';
import type {
  EntityDataDescriptor,
  EntityDesriptor,
} from '../../../shared/types/storage-entities';
import type {
  MarketChartUpdateMode,
} from '../controllers/MarketStatisticsView';
import type {
  AnyEntityDataKindHandler,
} from '../entity-data-kinds/types';

export interface ChartPanelSeries {
  key: string;
  title: string;
  descriptor: EntityDesriptor;
  dataDescriptor: EntityDataDescriptor;
  entityIndex: number;
  handler: AnyEntityDataKindHandler;
  settings: unknown;
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

      item.handler.applySettings(
        managed.series,
        item.settings,
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
    const data = [];

    for (
      let index = context.startIndex;
      index <= context.endIndex;
      index++
    ) {
      data.push(
        item.handler.getData({
          accessors: context.accessors,
          descriptor: item.descriptor,
          dataDescriptor: item.dataDescriptor,
          index,
        }),
      );
    }

    item.handler.setData(
      managed.series,
      data,
    );

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

    const data = item.handler.getData({
      accessors: context.accessors,
      descriptor: item.descriptor,
      dataDescriptor: item.dataDescriptor,
      index: context.endIndex,
    });

    item.handler.updateSeries(
      managed.series,
      data,
    );
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

    const managed: ManagedChartPanelSeries = {
      series: item.handler.createSeries(
        {
          chart: this.chart,
          panelIndex: this.panelIndex,
          title: item.title,
        },
        item.settings,
      ),
      isInitialized: false,
    };

    this.seriesByKey.set(
      item.key,
      managed,
    );

    return managed;
  }
}
