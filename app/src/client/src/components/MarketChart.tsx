// app/src/client/src/components/MarketChart.tsx
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
  candleSeries: MarketChartCandleSeries[];
  chartVersion: number;
  visibleRange: MarketChartVisibleRange;
}

export const MarketChart = ({
  candleSeries,
  chartVersion,
  visibleRange,
}: MarketChartProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const candleSeriesByLevelRef =
    useRef<Map<number, ISeriesApi<'Candlestick'>>>(new Map());

  const lineSeriesByLevelRef =
    useRef<Map<number, ISeriesApi<'Line'>>>(new Map());

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
      candleSeriesByLevelRef.current.clear();
      lineSeriesByLevelRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;

    if (!chart) {
      return;
    }

    const activeLevels = new Set(
      candleSeries.map((series) => series.level),
    );

    for (const [level, series] of candleSeriesByLevelRef.current) {
      if (!activeLevels.has(level)) {
        chart.removeSeries(series);
        candleSeriesByLevelRef.current.delete(level);
      }
    }

    for (const [level, series] of lineSeriesByLevelRef.current) {
      if (!activeLevels.has(level)) {
        chart.removeSeries(series);
        lineSeriesByLevelRef.current.delete(level);
      }
    }

    for (const item of candleSeries) {
      let candleSeriesItem =
        candleSeriesByLevelRef.current.get(item.level);

      if (!candleSeriesItem) {
        candleSeriesItem = chart.addSeries(CandlestickSeries, {
          priceLineVisible: false,
          lastValueVisible: false,
        });

        candleSeriesByLevelRef.current.set(item.level, candleSeriesItem);
      }

      candleSeriesItem.setData(item.data);

      let lineSeriesItem =
        lineSeriesByLevelRef.current.get(item.level);

      if (!lineSeriesItem) {
        lineSeriesItem = chart.addSeries(LineSeries, {
          lineWidth: 1,
          priceLineVisible: item.level === 0,
          lastValueVisible: item.level === 0,
        });

        lineSeriesByLevelRef.current.set(item.level, lineSeriesItem);
      }

      lineSeriesItem.setData(
        item.data.map<MarketChartLinePoint>((candle) => ({
          time: candle.time,
          value: candle.close,
        })),
      );
    }

    const hasData = candleSeries.some(
      (series) => series.data.length > 0,
    );

    if (hasData) {
      chart.timeScale().setVisibleRange(visibleRange);
    }
  }, [
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