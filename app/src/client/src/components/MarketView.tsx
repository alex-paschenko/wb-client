import {
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  FRONTEND_WS_SUBSCRIPTION_ACTIONS,
} from '../../../shared/constants/frontend-ws';
import { MarketStatisticsStorageService } from '../../../shared/services/market-statistics-storage';
import type {
  MarketStatisticsItem,
} from '../../../shared/types/market-statistics-storage';
import {
  appEvents,
} from '../events/app-events';
import type { OpenMarketViewState } from '../../../shared/types/frontend-settings';
import { useAppContext } from '../contexts/AppContext';
import { DashboardItem } from './DashboardItem';
import { MarketChart } from './MarketChart';

interface MarketViewProps {
  marketName: string;
  size: OpenMarketViewState;
  index: number;
}

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

  const storageRef = useRef<MarketStatisticsStorageService | null>(null);

  const [chartVersion, setChartVersion] = useState(0);

  useEffect(() => {
    const handleFullSync = (
      payload: {
        marketName: string;
        levels: MarketStatisticsItem[][];
      },
    ) => {
      const storage = new MarketStatisticsStorageService(marketName);

      for (const [level, items] of payload.levels.entries()) {
        for (const item of items) {
          storage.addItem(level, item, 'suppress record delta');
        }
      }

      storageRef.current = storage;
      setChartVersion((version) => version + 1);

      appEvents.emit(
        'changeMarketStatisticsSubscription',
        FRONTEND_WS_SUBSCRIPTION_ACTIONS.add,
        [marketName],
      );
    };

    const handleDelta = (
      payload: {
        marketName: string;
        delta: ArrayBuffer;
      },
    ) => {
      const storage = storageRef.current;

      if (!storage) {
        return;
      }

      storage.applyDelta(payload.delta);
      setChartVersion((version) => version + 1);
    };

    const unsubscribeFullSync = appEvents.on(
      'marketStatisticsFullSyncReceived',
      handleFullSync,
      marketName,
    );

    const unsubscribeDelta = appEvents.on(
      'marketStatisticsDeltaReceived',
      handleDelta,
      marketName,
    );

    appEvents.emit('requestMarketStatisticsFullSync', marketName);

    return () => {
      unsubscribeFullSync();
      unsubscribeDelta();

      appEvents.emit(
        'changeMarketStatisticsSubscription',
        FRONTEND_WS_SUBSCRIPTION_ACTIONS.remove,
        [marketName],
      );
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
        <header className="shrink-0 border-b border-panel-border px-2 py-1 text-left text-xs font-semibold text-accent">
          {marketName}
        </header>

        <div className="min-h-0 flex-1">
          <div className="relative h-full w-full">
            <MarketChart
              storage={storageRef.current}
              version={chartVersion}
            />
          </div>
        </div>
      </div>
    </DashboardItem>
  );
};
