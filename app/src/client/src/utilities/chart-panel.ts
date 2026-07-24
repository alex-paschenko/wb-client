// app/src/client/src/utilities/chart-panel.ts

import type {
  IChartApi,
} from 'lightweight-charts';

import {
  ChartPanelSeriesManager,
  type ChartPanelSeries,
} from './chart-panel-series-manager';

export interface ChartPanelData {
  group: string;
  series: readonly ChartPanelSeries[];
}

export class ChartPanel {
  private readonly seriesManager: ChartPanelSeriesManager;

  public constructor(
    chart: IChartApi,
    public readonly group: string,
    private panelIndex: number,
  ) {
    this.seriesManager = new ChartPanelSeriesManager(chart, panelIndex);
  }

  public sync(series: readonly ChartPanelSeries[]): void {
    this.seriesManager.sync(series);
  }

  public moveTo(panelIndex: number): void {
    if (this.panelIndex === panelIndex) {
      return;
    }

    this.panelIndex = panelIndex;
    this.seriesManager.moveToPanel(panelIndex);
  }

  public dispose(): void {
    this.seriesManager.dispose();
  }
}
