import { marketsDao } from '../dao/markets.js';
import { whitebitClient } from '../whitebit/public-client.js';

export const syncMarkets = async () => {
  const whitebitMarkets = await whitebitClient.getMarkets();

  const syncedMarkets = await Promise.all(
    whitebitMarkets.map((market) =>
      marketsDao.upsert({
        symbol: market.name,
        baseAsset: market.stock,
        quoteAsset: market.money,
        isActive: true,
      }),
    ),
  );

  return syncedMarkets;
};
