import type {
  MarketsByName,
} from '../../shared/types/market.js';
import { SERVER_EVENT } from '../constants/events.js';
import { marketsDao } from '../db/dao/markets.js';
import { whitebitPrivateClient } from '../whitebit/private-client.js';
import { getMarkets } from '../whitebit/markets-adapter.js';
import { buildMarketFeesByName } from '../whitebit/market-fees-adapter.js';
import { eventBus } from './event-bus.js';

let pending: Promise<{ markets: number }> | null = null;

async function refresh(): Promise<{ markets: number }> {
  // Do not publish anything until both requests have succeeded.
  const markets = await getMarkets();
  const response = await whitebitPrivateClient.getAllMarketFees();
  const fees = buildMarketFeesByName(markets, response);

  // Persist metadata before exposing a new snapshot to consumers.
  await marketsDao.refreshAll(markets);

  const active = markets.filter((market) => market.tradesEnabled);
  const marketsByName: MarketsByName = Object.fromEntries(
    active.map((market) => [market.name, market]),
  );
  eventBus.emit(SERVER_EVENT.marketDataUpdated, {
    markets: marketsByName,
    marketFees: Object.fromEntries(
      active.map((market) => [market.name, fees[market.name]]),
    ),
    marketNames: active.map((market) => market.name),
  });
  return { markets: active.length };
}

export function syncMarketData(): Promise<{ markets: number }> {
  if (!pending) {
    pending = refresh().finally(() => { pending = null; });
  }
  return pending;
}
