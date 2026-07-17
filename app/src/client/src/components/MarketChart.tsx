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
  MarketChartCandlePoint,
  MarketChartLinePoint,
  MarketChartVisibleRange,
} from '../controllers/MarketStatisticsView';

interface MarketChartProps {
  candleData: MarketChartCandlePoint[];
  chartVersion: number;
  visibleRange: MarketChartVisibleRange;
}

export const MarketChart = ({
  candleData,
  chartVersion,
  visibleRange,
}: MarketChartProps) => {
  const containerRef =
    useRef<HTMLDivElement | null>(null);

  const chartRef =
    useRef<IChartApi | null>(null);

  const candleSeriesRef =
    useRef<ISeriesApi<'Candlestick'> | null>(
      null,
    );

  const lineSeriesRef =
    useRef<ISeriesApi<'Line'> | null>(
      null,
    );

  useEffect(() => {
    const container =
      containerRef.current;

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
        textColor:
          getComputedStyle(
            document.documentElement,
          )
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

    const candleSeries =
      chart.addSeries(
        CandlestickSeries,
        {
          priceLineVisible: false,
          lastValueVisible: false,
        },
      );

    const lineSeries =
      chart.addSeries(
        LineSeries,
        {
          lineWidth: 1,
          priceLineVisible: true,
          lastValueVisible: true,
        },
      );

    chartRef.current = chart;
    candleSeriesRef.current =
      candleSeries;
    lineSeriesRef.current =
      lineSeries;

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
      chart.remove();

      chartRef.current = null;
      candleSeriesRef.current = null;
      lineSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart =
      chartRef.current;

    const candleSeries =
      candleSeriesRef.current;

    const lineSeries =
      lineSeriesRef.current;

    if (
      !chart ||
      !candleSeries ||
      !lineSeries
    ) {
      return;
    }

    candleSeries.setData(
      candleData,
    );

    lineSeries.setData(
      candleData.map<MarketChartLinePoint>(
        (candle) => ({
          time: candle.time,
          value: candle.close,
        }),
      ),
    );

    if (candleData.length > 0) {
      chart.timeScale().setVisibleRange(
        visibleRange,
      );
    }
  }, [
    candleData,
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
