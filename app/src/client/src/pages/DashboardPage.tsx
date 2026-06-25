import {
  MARKET_VIEW_STATES,
  type OpenMarketViewState,
} from '../../../shared/types/frontend-settings';
import { LogPanel } from '../components/LogPanel';
import { MarketView } from '../components/MarketView';
import { useAppContext } from '../contexts/AppContext';

export const DashboardPage = () => {
  const {
    markets,
    settings,
    openMarket,
  } = useAppContext();

  const visibleMarketItems = settings
    .getMarketsViewStates()
    .filter(({ marketName, state }) => {
      return (
        state !== MARKET_VIEW_STATES.closed &&
        markets[marketName]
      );
    });

  const closedMarketItems = settings
    .getMarketsViewStates()
    .filter(({ marketName, state }) => {
      return (
        state === MARKET_VIEW_STATES.closed &&
        markets[marketName]
      );
    });

  return (
    <div className="flex w-full flex-col gap-3">
      <LogPanel />

      <section className="main-gap flex w-full flex-wrap content-start">
        {visibleMarketItems.map((item, index) => (
          <MarketView
            key={item.marketName}
            marketName={item.marketName}
            size={item.state as OpenMarketViewState}
            index={index}
          />
        ))}
      </section>

      <section className="closed-markets-grid">
        {closedMarketItems.map((item) => (
          <button
            key={item.marketName}
            type="button"
            className="app-button truncate px-2 py-1 text-xs"
            onClick={() => openMarket(item.marketName)}
          >
            {item.marketName}
          </button>
        ))}
      </section>
    </div>
  );
};
