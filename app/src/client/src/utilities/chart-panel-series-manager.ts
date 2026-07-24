// app/src/client/src/utilities/chart-panel-series-manager.ts

import {
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  LineSeries,
} from 'lightweight-charts';

import type {
  MarketChartLinePoint,
} from '../controllers/MarketStatisticsView';

export interface ChartPanelSeries {
  indicatorName: string;
  color: string;
  data: MarketChartLinePoint[];
}

interface ManagedChartPanelSeries {
  series: ISeriesApi<'Line'>;
  priceLine: IPriceLine | null;
}

export class ChartPanelSeriesManager {
  private readonly seriesByIndicatorName =
    new Map<string, ManagedChartPanelSeries>();

  public constructor(
    private readonly chart: IChartApi,
    private panelIndex: number,
  ) {}

  public sync(panelSeries: readonly ChartPanelSeries[]): void {
    const activeIndicatorNames = new Set(
      panelSeries.map((series) => series.indicatorName),
    );

    this.removeInactiveSeries(activeIndicatorNames);

    for (const panelSeriesItem of panelSeries) {
      const managedSeries =
        this.getOrCreateSeries(panelSeriesItem);

      managedSeries.series.applyOptions({
        color: panelSeriesItem.color,
      });

      managedSeries.series.setData(panelSeriesItem.data);

      this.syncPriceLine(
        managedSeries,
        panelSeriesItem,
      );
    }
  }

  public moveToPanel(panelIndex: number): void {
    if (this.panelIndex === panelIndex) {
      return;
    }

    this.panelIndex = panelIndex;

    for (const managedSeries of this.seriesByIndicatorName.values()) {
      managedSeries.series.moveToPane(panelIndex);
    }
  }

  public dispose(): void {
    for (const managedSeries of this.seriesByIndicatorName.values()) {
      this.removeManagedSeries(managedSeries);
    }

    this.seriesByIndicatorName.clear();
  }

  private syncPriceLine(
    managedSeries: ManagedChartPanelSeries,
    panelSeries: ChartPanelSeries,
  ): void {
    const lastValue = this.getLastValue(panelSeries.data);

    if (lastValue === null) {
      this.removePriceLine(managedSeries);
      return;
    }

    const options = {
      price: lastValue,
      title: panelSeries.indicatorName,
      color: panelSeries.color,
      lineVisible: false,
      axisLabelVisible: true,
      axisLabelColor: panelSeries.color,
    };

    if (!managedSeries.priceLine) {
      managedSeries.priceLine =
        managedSeries.series.createPriceLine(options);

      return;
    }

    managedSeries.priceLine.applyOptions(options);
  }

  private getLastValue(
    data: readonly MarketChartLinePoint[],
  ): number | null {
    for (let index = data.length - 1; index >= 0; index -= 1) {
      const point = data[index];

      if (point && 'value' in point) {
        return point.value;
      }
    }

    return null;
  }

  private removeInactiveSeries(
    activeIndicatorNames: ReadonlySet<string>,
  ): void {
    for (const [
      indicatorName,
      managedSeries,
    ] of this.seriesByIndicatorName) {
      if (activeIndicatorNames.has(indicatorName)) {
        continue;
      }

      this.removeManagedSeries(managedSeries);
      this.seriesByIndicatorName.delete(indicatorName);
    }
  }

  private removeManagedSeries(
    managedSeries: ManagedChartPanelSeries,
  ): void {
    this.removePriceLine(managedSeries);
    this.chart.removeSeries(managedSeries.series);
  }

  private removePriceLine(
    managedSeries: ManagedChartPanelSeries,
  ): void {
    if (!managedSeries.priceLine) {
      return;
    }

    managedSeries.series.removePriceLine(
      managedSeries.priceLine,
    );

    managedSeries.priceLine = null;
  }

  private getOrCreateSeries(
    panelSeries: ChartPanelSeries,
  ): ManagedChartPanelSeries {
    const existingSeries =
      this.seriesByIndicatorName.get(panelSeries.indicatorName);

    if (existingSeries) {
      return existingSeries;
    }

    const series = this.chart.addSeries(
      LineSeries,
      {
        color: panelSeries.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      },
      this.panelIndex,
    );

    const managedSeries: ManagedChartPanelSeries = {
      series,
      priceLine: null,
    };

    this.seriesByIndicatorName.set(
      panelSeries.indicatorName,
      managedSeries,
    );

    return managedSeries;
  }
}
