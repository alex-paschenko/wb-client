import {
  useMemo,
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

import {
  MarketStatisticsController,
} from '../controllers/MarketStatisticsController';

import {
  useAppContext,
} from '../contexts/AppContext';

import {
  useController,
} from '../hooks/useController';

import {
  DashboardItem,
} from './DashboardItem';

import {
  DropdownButton,
} from './DropdownButton';

import {
  MarketChart,
} from './MarketChart';

interface MarketViewProps {
  marketName: string;
  size: OpenMarketViewState;
  index: number;
}

const defaultDuration = MARKET_STATISTICS_LEVEL_DURATIONS[0];

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

  const controller = useMemo(() => {
    return new MarketStatisticsController(
      marketName,
      {
        interval: defaultDuration.interval,
      },
    );
  }, [marketName]);

  const controllerState = useController(controller);

  const selectedDuration = useMemo(() => {
    return MARKET_STATISTICS_LEVEL_DURATIONS.find(
      (item) => item.interval === controllerState.selectedInterval,
    ) ?? defaultDuration;
  }, [controllerState.selectedInterval]);

  const durationItems = useMemo(() => {
    return MARKET_STATISTICS_LEVEL_DURATIONS.map((duration) => ({
      value: duration.interval,
      label: t(`time.units.${duration.unit}`, {
        count: duration.count,
      }),
    }));
  }, [t]);

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
        </header>

        <div className="min-h-0 flex-1">
          <div className="relative h-full w-full">
            <MarketChart
              snapshotData={controllerState.snapshotData}
              candleSeries={controllerState.candleSeries}
              chartVersion={controllerState.chartVersion}
              visibleRange={controllerState.visibleRange}
            />

            <div className="absolute left-2 top-2 z-30 flex items-center gap-2 rounded-md bg-panel/45 px-2 py-1 text-xs text-muted opacity-45 transition hover:bg-panel/90 hover:opacity-100">
              <span>
                points: {controllerState.pointsCount}
              </span>

              <DropdownButton
                label={t(`time.units.${selectedDuration.unit}`, {
                  count: selectedDuration.count,
                })}
                items={durationItems}
                onSelect={(interval) => {
                  controller.setInterval(interval);
                }}
                panelMaxHeightClassName="max-h-40"
              />
            </div>
          </div>
        </div>
      </div>
    </DashboardItem>
  );
};
