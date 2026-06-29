import {
  useEffect,
  useState,
} from 'react';

import type {
  OpenMarketViewState,
} from '../../../shared/types/frontend-settings';
import {
  MarketStatisticsController,
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

const createInitialControllerState =
  (): MarketStatisticsControllerState => ({
    pointsCount: 0,
    fullSyncVersion: 0,
    chartData: [],
    lastSnapshot: null,
    rollingStatistics: null,
  });

export const MarketView = ({
  marketName,
  size,
  index,
}: MarketViewProps) => {
  const {
    closeMarket,
    setMarketViewState,
    moveMarket,
  } = useAppContext();

  const [controllerState, setControllerState] =
    useState<MarketStatisticsControllerState>(
      createInitialControllerState,
    );

  useEffect(() => {
    setControllerState(createInitialControllerState());

    const controller = new MarketStatisticsController(
      marketName,
      setControllerState,
    );

    controller.start();

    return () => {
      controller.stop();
    };
  }, [marketName]);

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
              data={controllerState.chartData}
              fullSyncVersion={controllerState.fullSyncVersion}
              lastSnapshot={controllerState.lastSnapshot}
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
