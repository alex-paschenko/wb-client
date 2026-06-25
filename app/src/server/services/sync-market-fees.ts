import type { MarketFee } from '../types/market-fee.js';
import { whitebitPrivateClient } from '../whitebit/private-client.js';

import { marketFeeStore } from './market-fee-store.js';

const percentToRatio = (percent: string): number =>
  Number(percent) / 100;

let isSyncing = false;

export const syncMarketFees = async (): Promise<{
  hasFee: boolean;
}> => {
  if (isSyncing) {
    return {
      hasFee: Boolean(marketFeeStore.getFee()),
    };
  }

  isSyncing = true;

  try {
    const response =
      await whitebitPrivateClient.getAllMarketFees();

    const fee: MarketFee = {
      makerFeeRatio: percentToRatio(response.maker),
      takerFeeRatio: percentToRatio(response.taker),
      source: 'private',
    };

    marketFeeStore.setFee(fee);

    return {
      hasFee: true,
    };
  } catch (error) {
    console.error('syncMarketFees failed', error);

    return {
      hasFee: Boolean(marketFeeStore.getFee()),
    };
  } finally {
    isSyncing = false;
  }
};

export const getMarketFee = (): MarketFee | null =>
  marketFeeStore.getFee();
