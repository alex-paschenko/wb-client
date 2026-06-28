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
import { OpenMarketViewState } from '../../../shared/types/frontend-settings';
import { useAppContext } from '../contexts/AppContext';
import { DashboardItem } from './DashboardItem';

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

  const [pointsCount, setPointsCount] = useState(0);

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
      setPointsCount(storage.getPointSeriesLength());
console.log(`Full sync for ${marketName}: ${storage.size()} (including ${storage.size(0)} 0-level items)`)
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
      setPointsCount(storage.getPointSeriesLength());
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
          <div className="flex h-full items-center justify-center text-sm text-muted">
            points: {pointsCount}
          </div>
        </div>
      </div>
    </DashboardItem>
  );
};
