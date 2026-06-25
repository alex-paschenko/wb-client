import {
  MARKET_VIEW_STATES,
  type OpenMarketViewState,
} from '../../../shared/types/frontend-settings';
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
            chart placeholder
          </div>
        </div>
      </div>
    </DashboardItem>
  );
};
