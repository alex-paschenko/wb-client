// app/src/client/src/components/MarketChart.tsx

import { useEffect, useMemo, useRef } from 'react';
import { createChart, type IChartApi} from 'lightweight-charts';
import { useTranslation } from 'react-i18next';

import { truncateMiddle } from '../utilities/string';
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
  getEntityDataKey,
  getLineEntitySettings,
  getOhlcEntitySettings,
} from '../entity-data/utilities';
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
  const { t } = useTranslation();

  const containerRef = useRef<HTMLDivElement | null>(null);

  const chartRef = useRef<IChartApi | null>(null);

  const panelManagerRef = useRef<ChartPanelManager | null>(null);

  const panels = useMemo<ChartPanelData[]>(() => {
    const seriesByGroup = new Map<string, ChartPanelSeries[]>();

  for (const [entityIndex, descriptor] of entities.entries()) {
    for (const [dataIndex, data] of descriptor.data.entries()) {
      const dataKey = getEntityDataKey(data);
      const colorIndex = entityIndex + dataIndex;

      const dataSettings = data.kind === 'line'
        ? getLineEntitySettings(
            settings,
            descriptor,
            data,
            colorIndex,
          )
        : getOhlcEntitySettings(
            settings,
            descriptor,
            data,
          );

      if (!dataSettings.isVisible) {
        continue;
      }

      let groupSeries = seriesByGroup.get(data.group);

      if (!groupSeries) {
        groupSeries = [];
        seriesByGroup.set(data.group, groupSeries);
      }

      const translatedName = data.key
        ? t(`chart.entityData.${data.key}`, { defaultValue: data.key })
        : descriptor.name;

      const title = truncateMiddle(translatedName, 10);

      groupSeries.push({
        key: [
          descriptor.kind,
          descriptor.name,
          dataKey,
          data.group,
        ].join(':'),
        title,
        descriptor,
        dataDescriptor: data,
        settings: dataSettings,
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
    t,
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
