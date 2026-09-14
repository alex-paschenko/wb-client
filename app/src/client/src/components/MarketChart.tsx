// app/src/client/src/components/MarketChart.tsx

import {
  useEffect,
  useMemo,
  useRef,
} from 'react';
import {
  createChart,
  type IChartApi,
} from 'lightweight-charts';

import type {
  FrontendSettings,
} from '../../../shared/services/frontend-settings';
import type { Storage } from '../../../shared/services/storage';
import type {
  EntityDesriptor,
} from '../../../shared/types/storage-entities';
import type {
  MarketChartUpdateMode,
  MarketChartVisibleRange,
} from '../controllers/MarketStatisticsView';
import {
  ENTITY_DATA_KIND_HANDLERS,
} from '../entity-data-kinds';
import type {
  ChartPanelData,
} from '../utilities/chart-panel';
import {
  ChartPanelManager,
} from '../utilities/chart-panel-manager';
import type {
  ChartPanelSeries,
} from '../utilities/chart-panel-series-manager';

interface MarketChartProps {
  storage: Storage | null;
  entities: readonly EntityDesriptor[];
  settings: FrontendSettings;

  startIndex: number;
  endIndex: number;

  updateMode: MarketChartUpdateMode;
  chartVersion: number;
  visibleRange: MarketChartVisibleRange;
}

export const MarketChart = ({
  storage,
  entities,
  settings,
  startIndex,
  endIndex,
  updateMode,
  chartVersion,
  visibleRange,
}: MarketChartProps) => {
  const containerRef =
    useRef<HTMLDivElement | null>(null);

  const chartRef =
    useRef<IChartApi | null>(null);

  const panelManagerRef =
    useRef<ChartPanelManager | null>(null);

  const panels = useMemo<ChartPanelData[]>(() => {
    const seriesByGroup =
      new Map<string, ChartPanelSeries[]>();

    for (
      const [entityIndex, descriptor]
      of entities.entries()
    ) {
      for (const dataKind of descriptor.dataKind) {
        const handler =
          ENTITY_DATA_KIND_HANDLERS[dataKind];

        const handlerSettings =
          handler.getSettings(
            settings,
            descriptor,
            entityIndex,
          );

        if (!handler.isVisible(handlerSettings)) {
          continue;
        }

        let groupSeries =
          seriesByGroup.get(descriptor.group);

        if (!groupSeries) {
          groupSeries = [];
          seriesByGroup.set(
            descriptor.group,
            groupSeries,
          );
        }

        groupSeries.push({
          key:
            `${descriptor.kind}:` +
            `${descriptor.name}:` +
            `${dataKind}`,
          descriptor,
          entityIndex,
          handler,
          settings: handlerSettings,
        });
      }
    }

    return Array.from(
      seriesByGroup,
      ([group, series]) => ({
        group,
        series,
      }),
    );
  }, [
    entities,
    settings,
  ]);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const textColor =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-muted')
        .trim();

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,

      layout: {
        background: {
          color: 'transparent',
        },
        textColor,
      },

      grid: {
        vertLines: {
          visible: false,
        },
        horzLines: {
          visible: false,
        },
      },

      rightPriceScale: {
        borderVisible: false,
      },

      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: true,
        minBarSpacing: 0.02,
        barSpacing: 0.2,
      },
    });

    chartRef.current = chart;
    panelManagerRef.current =
      new ChartPanelManager(chart);

    const resizeObserver =
      new ResizeObserver(() => {
        chart.applyOptions({
          width: container.clientWidth,
          height: container.clientHeight,
        });
      });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();

      panelManagerRef.current?.dispose();
      chart.remove();

      chartRef.current = null;
      panelManagerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const panelManager = panelManagerRef.current;

    if (!chart || !panelManager || !storage) {
      return;
    }

    try {
      panelManager.sync(
        panels,
        {
          accessors: storage.getAccessors(),
          startIndex,
          endIndex,
          updateMode,
        },
      );

      if (endIndex >= startIndex) {
        chart.timeScale().setVisibleRange(visibleRange);
      }
    } finally {
      storage.clearLazyArrayCaches();
    }
  }, [
    storage,
    panels,
    startIndex,
    endIndex,
    updateMode,
    chartVersion,
    visibleRange,
  ]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
    />
  );
};
