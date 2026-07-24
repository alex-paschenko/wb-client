// app/src/client/src/components/MarketChart.tsx

import { useEffect, useRef } from 'react';

import {
  CandlestickSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
} from 'lightweight-charts';

import type {
  MarketChartCandlePoint,
  MarketChartLinePoint,
  MarketChartVisibleRange,
} from '../controllers/MarketStatisticsView';
import type {
  ChartPanelData,
} from '../utilities/chart-panel';
import {
  ChartPanelManager,
} from '../utilities/chart-panel-manager';

interface MarketChartProps {
  candleData: MarketChartCandlePoint[];
  candleLineColor: string;
  panels: ChartPanelData[];
  chartVersion: number;
  visibleRange: MarketChartVisibleRange;
}

export const MarketChart = ({
  candleData,
  candleLineColor,
  panels,
  chartVersion,
  visibleRange,
}: MarketChartProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const candleSeriesRef =
    useRef<ISeriesApi<'Candlestick'> | null>(null);

  const candleLineSeriesRef =
    useRef<ISeriesApi<'Line'> | null>(null);

  const panelManagerRef =
    useRef<ChartPanelManager | null>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const textColor = getComputedStyle(document.documentElement)
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

    const candleSeries = chart.addSeries(
      CandlestickSeries,
      {
        priceLineVisible: false,
        lastValueVisible: false,
      },
      0,
    );

    const candleLineSeries = chart.addSeries(
      LineSeries,
      {
        lineWidth: 1,
        priceLineVisible: true,
        lastValueVisible: true,
      },
      0,
    );

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    candleLineSeriesRef.current = candleLineSeries;
    panelManagerRef.current = new ChartPanelManager(chart);

    const resizeObserver = new ResizeObserver(() => {
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
      candleSeriesRef.current = null;
      candleLineSeriesRef.current = null;
      panelManagerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const candleLineSeries = candleLineSeriesRef.current;
    const panelManager = panelManagerRef.current;

    if (
      !chart ||
      !candleSeries ||
      !candleLineSeries ||
      !panelManager
    ) {
      return;
    }

    candleSeries.setData(candleData);

    candleLineSeries.applyOptions({
      color: candleLineColor,
    });

    candleLineSeries.setData(
      candleData.map<MarketChartLinePoint>((candle) => ({
        time: candle.time,
        value: candle.close,
      })),
    );

    panelManager.sync(panels);

    if (candleData.length > 0) {
      chart.timeScale().setVisibleRange(visibleRange);
    }
  }, [
    candleData,
    candleLineColor,
    panels,
    chartVersion,
    visibleRange,
  ]);

  return <div ref={containerRef} className="h-full w-full" />;
};
