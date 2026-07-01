import {
  useEffect,
  useRef,
} from 'react';
import {
  CandlestickSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
} from 'lightweight-charts';

import type {
  MarketChartCandleSeries,
  MarketChartLinePoint,
  MarketChartVisibleRange,
} from '../controllers/MarketStatisticsView';

interface MarketChartProps {
  snapshotData: MarketChartLinePoint[];
  candleSeries: MarketChartCandleSeries[];
  chartVersion: number;
  visibleRange: MarketChartVisibleRange;
}

export const MarketChart = ({
  snapshotData,
  candleSeries,
  chartVersion,
  visibleRange,
}: MarketChartProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const snapshotSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const candleSeriesByLevelRef =
    useRef<Map<number, ISeriesApi<'Candlestick'>>>(new Map());

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: {
          color: 'transparent',
        },
        textColor: getComputedStyle(document.documentElement)
          .getPropertyValue('--color-muted')
          .trim(),
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

    snapshotSeriesRef.current = chart.addSeries(LineSeries, {
      lineWidth: 2,
    });

    chartRef.current = chart;

    const resizeObserver = new ResizeObserver(() => {
      chart.applyOptions({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();

      chartRef.current = null;
      snapshotSeriesRef.current = null;
      candleSeriesByLevelRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const snapshotSeries = snapshotSeriesRef.current;

    if (!chart || !snapshotSeries) {
      return;
    }

    snapshotSeries.setData(snapshotData);

    const activeLevels = new Set(
      candleSeries.map((series) => series.level),
    );

    for (const [level, series] of candleSeriesByLevelRef.current) {
      if (!activeLevels.has(level)) {
        chart.removeSeries(series);
        candleSeriesByLevelRef.current.delete(level);
      }
    }

    for (const item of candleSeries) {
      let series = candleSeriesByLevelRef.current.get(item.level);

      if (!series) {
        series = chart.addSeries(CandlestickSeries);
        candleSeriesByLevelRef.current.set(item.level, series);
      }

      series.setData(item.data);
    }

    const hasData =
      snapshotData.length > 0 ||
      candleSeries.some((series) => series.data.length > 0);

    if (hasData) {
      chart.timeScale().setVisibleRange(visibleRange);
    }
  }, [
    snapshotData,
    candleSeries,
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
