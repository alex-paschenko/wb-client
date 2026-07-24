// app/src/client/src/utilities/chart-panel-manager.ts

import type {
  IChartApi,
} from 'lightweight-charts';

import {
  ChartPanel,
  type ChartPanelData,
} from './chart-panel';

export class ChartPanelManager {
  private readonly panelsByGroup = new Map<string, ChartPanel>();
  private panelGroups: string[] = [];

  public constructor(private readonly chart: IChartApi) {}

  public sync(panelData: readonly ChartPanelData[]): void {
    const panelGroups = panelData.map((panel) => panel.group);

    if (!this.hasSamePanelGroups(panelGroups)) {
      this.rebuild(panelData);
      return;
    }

    for (const panelDataItem of panelData) {
      this.panelsByGroup
        .get(panelDataItem.group)
        ?.sync(panelDataItem.series);
    }
  }

  public dispose(): void {
    this.disposePanels();
    this.panelGroups = [];
  }

  private rebuild(panelData: readonly ChartPanelData[]): void {
    this.disposePanels();

    for (const [panelIndex, panelDataItem] of panelData.entries()) {
      const panel = new ChartPanel(
        this.chart,
        panelDataItem.group,
        panelIndex,
      );

      panel.sync(panelDataItem.series);
      this.panelsByGroup.set(panelDataItem.group, panel);
    }

    this.panelGroups = panelData.map((panel) => panel.group);
  }

  private disposePanels(): void {
    const panels = [...this.panelsByGroup.values()].reverse();

    for (const panel of panels) {
      panel.dispose();
    }

    this.panelsByGroup.clear();
  }

  private hasSamePanelGroups(
    panelGroups: readonly string[],
  ): boolean {
    if (panelGroups.length !== this.panelGroups.length) {
      return false;
    }

    return panelGroups.every((group, index) => {
      return group === this.panelGroups[index];
    });
  }
}
