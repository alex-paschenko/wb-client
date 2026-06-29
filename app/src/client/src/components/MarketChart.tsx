import {
  useEffect,
  useRef,
} from 'react';
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';

import type {
  MarketSnapshot,
} from '../../../shared/types/market-statistics-storage';

export type MarketChartLinePoint = LineData<UTCTimestamp>;

interface MarketChartProps {
  data: MarketChartLinePoint[];
  fullSyncVersion: number;
  lastSnapshot: MarketSnapshot | null;
}

const toChartTime = (
  receivedAt: number,
): UTCTimestamp => {
  return Math.floor(receivedAt / 1000) as UTCTimestamp;
};

const updateLineSeries = (
  series: ISeriesApi<'Line'>,
  snapshot: MarketSnapshot,
  lastUpdatedTimeRef: ReturnType<typeof useRef<UTCTimestamp | null>>,
): void => {
  const time = toChartTime(snapshot.receivedAt);

  if (
    lastUpdatedTimeRef.current !== null &&
    Number(time) < Number(lastUpdatedTimeRef.current)
  ) {
    return;
  }

  series.update({
    time,
    value: snapshot.price,
  });

  lastUpdatedTimeRef.current = time;
};

export const MarketChart = ({
  data,
  fullSyncVersion,
  lastSnapshot,
}: MarketChartProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const lastUpdatedTimeRef = useRef<UTCTimestamp | null>(null);

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
      },
    });

    const series = chart.addSeries(LineSeries, {
      lineWidth: 2,
    });

    chartRef.current = chart;
    seriesRef.current = series;

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
      seriesRef.current = null;
      lastUpdatedTimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) {
      return;
    }

    seriesRef.current.setData(data);

    const lastPoint = data.at(-1);

    lastUpdatedTimeRef.current = lastPoint
      ? Number(lastPoint.time) as UTCTimestamp
      : null;

    chartRef.current?.timeScale().fitContent();
  }, [data, fullSyncVersion]);

  useEffect(() => {
    if (!lastSnapshot || !seriesRef.current) {
      return;
    }

    updateLineSeries(
      seriesRef.current,
      lastSnapshot,
      lastUpdatedTimeRef,
    );
  }, [lastSnapshot]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
    />
  );
};
