import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  useTranslation,
} from 'react-i18next';

import {
  MARKET_STATISTICS_LEVEL_DURATIONS,
} from '../../../shared/constants/market-statistics-config';
import type {
  OpenMarketViewState,
} from '../../../shared/types/frontend-settings';
import { DropdownButton } from './DropdownButton';
import {
  MarketStatisticsController,
  type MarketStatisticsChartMode,
  type MarketStatisticsControllerState,
} from '../controllers/MarketStatisticsController';
import { useAppContext } from '../contexts/AppContext';
import { DashboardItem } from './DashboardItem';
import { MarketChart } from './MarketChart';

interface MarketViewProps {
  marketName: string;
  size: OpenMarketViewState;
  index: number;
}

const defaultDuration = MARKET_STATISTICS_LEVEL_DURATIONS[0];

const createChartMode = (
  level: number,
): MarketStatisticsChartMode => {
  const duration =
    MARKET_STATISTICS_LEVEL_DURATIONS.find((item) => item.level === level) ??
    defaultDuration;

  return {
    level: duration.level,
    interval: duration.interval,
  };
};

const createInitialControllerState =
  (): MarketStatisticsControllerState => ({
    pointsCount: 0,
    chartVersion: 0,
    snapshotData: [],
    candleSeries: [],
    rollingStatistics: null,
  });

export const MarketView = ({
  marketName,
  size,
  index,
}: MarketViewProps) => {
  const { t } = useTranslation();

  const {
    closeMarket,
    setMarketViewState,
    moveMarket,
  } = useAppContext();

  const controllerRef =
    useRef<MarketStatisticsController | null>(null);

  const [selectedLevel, setSelectedLevel] =
    useState(defaultDuration.level);

  const [controllerState, setControllerState] =
    useState<MarketStatisticsControllerState>(
      createInitialControllerState,
    );

  const selectedDuration = useMemo(() => {
    return MARKET_STATISTICS_LEVEL_DURATIONS.find(
      (item) => item.level === selectedLevel,
    ) ?? defaultDuration;
  }, [selectedLevel]);

  const durationItems = useMemo(() => {
    return MARKET_STATISTICS_LEVEL_DURATIONS.map((duration) => ({
      value: duration.level,
      label: t(`time.units.${duration.unit}`, {
        count: duration.count,
      }),
    }));
  }, [t]);

  useEffect(() => {
    setControllerState(createInitialControllerState());

    const controller = new MarketStatisticsController(
      marketName,
      setControllerState,
      createChartMode(selectedLevel),
    );

    controllerRef.current = controller;
    controller.start();

    return () => {
      controller.stop();
      controllerRef.current = null;
    };
  }, [marketName]);

  useEffect(() => {
    controllerRef.current?.setChartMode(
      createChartMode(selectedLevel),
    );
  }, [selectedLevel]);

  return (
    <DashboardItem
      initialSize={size}
      heightClassName="item-height-md"
      controlsVisibility="hover"
      onClose={() => closeMarket(marketName)}
      onSizeChange={(nextSize) => {
        setMarketViewState(marketName, nextSize);
      }}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', marketName);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(event) => {
        event.preventDefault();

        const draggedMarketName =
          event.dataTransfer.getData('text/plain');

        if (
          draggedMarketName &&
          draggedMarketName !== marketName
        ) {
          moveMarket(draggedMarketName, index);
        }
      }}
    >
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-panel-border px-2 py-1 text-xs">
          <span className="font-semibold text-accent">
            {marketName}
          </span>

          {controllerState.rollingStatistics && (
            <>
              <span className="text-muted">
                O: {controllerState.rollingStatistics.open}
              </span>
              <span className="text-muted">
                H: {controllerState.rollingStatistics.high}
              </span>
              <span className="text-muted">
                L: {controllerState.rollingStatistics.low}
              </span>
              <span className="text-muted">
                C: {controllerState.rollingStatistics.close}
              </span>
              <span className="text-muted">
                V: {controllerState.rollingStatistics.stockVolume}
              </span>
            </>
          )}

          <div className="ml-auto">
            <DropdownButton
              label={t(`time.units.${selectedDuration.unit}`, {
                count: selectedDuration.count,
              })}
              items={durationItems}
              onSelect={(level) => setSelectedLevel(level)}
            />
          </div>
        </header>

        <div className="min-h-0 flex-1">
          <div className="relative h-full w-full">
            <MarketChart
              snapshotData={controllerState.snapshotData}
              candleSeries={controllerState.candleSeries}
              chartVersion={controllerState.chartVersion}
            />

            <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-panel/80 px-2 py-1 text-xs text-muted">
              points: {controllerState.pointsCount}
            </div>
          </div>
        </div>
      </div>
    </DashboardItem>
  );
};
