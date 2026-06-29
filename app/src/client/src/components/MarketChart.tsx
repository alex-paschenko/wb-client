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
  MarketStatisticsStorageService,
} from '../../../shared/services/market-statistics-storage';
import type {
  MarketSnapshot
} from '../../../shared/types/market-statistics-storage';

interface MarketChartProps {
  storage: MarketStatisticsStorageService | null;
  fullSyncVersion: number;
  lastSnapshot: MarketSnapshot | null;
}

const toChartTime = (
  receivedAt: number,
): UTCTimestamp => {
  return Math.floor(receivedAt / 1000) as UTCTimestamp;
};

const createLineData = (
  storage: MarketStatisticsStorageService,
): LineData[] => {
  const items = storage.createItems('direct');
  const dataByTime = new Map<UTCTimestamp, LineData>();

  for (let index = 0; index < items.length; index += 1) {
    const snapshot = items.get(index);
    const time = toChartTime(snapshot.receivedAt);

    dataByTime.set(time, {
      time,
      value: snapshot.price,
    });
  }

  return [...dataByTime.values()]
    .sort((left, right) => {
      return Number(left.time) - Number(right.time);
    });
};

export const MarketChart = ({
  storage,
  fullSyncVersion,
  lastSnapshot,
}: MarketChartProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  const lastUpdatedTimeRef = useRef<UTCTimestamp | null>(null);

  const updateLineSeries = (
    series: ISeriesApi<'Line'>,
    snapshot: MarketSnapshot,
    lastUpdTimeRef: typeof lastUpdatedTimeRef,
  ): void => {
    const time = toChartTime(snapshot.receivedAt);

    if (
      lastUpdTimeRef.current !== null &&
      Number(time) < Number(lastUpdTimeRef.current)
    ) {
      return;
    }

    series.update({
      time,
      value: snapshot.price,
    });

    lastUpdTimeRef.current = time;
  };

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
    };
  }, []);

  useEffect(() => {
    if (!storage || !seriesRef.current) {
      return;
    }

    const data = createLineData(storage);

    seriesRef.current.setData(data);

    const lastPoint = data.at(-1);

    lastUpdatedTimeRef.current = lastPoint
      ? Number(lastPoint.time) as UTCTimestamp
      : null;

    chartRef.current?.timeScale().fitContent();
  }, [storage, fullSyncVersion]);

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
