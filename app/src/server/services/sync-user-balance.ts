import { userBalanceStore } from './user-balance-store.js';

import { whitebitPrivateClient } from '../whitebit/private-client.js';
import type { UserBalance } from '../types/user-balance.js';

let isSyncing = false;

export const syncUserBalance = async (
  userId: number,
): Promise<void> => {
  if (isSyncing) {
    return;
  }

  isSyncing = true;
  userBalanceStore.setUnknown(userId);

  try {
    const balanceFromExchange =
      await whitebitPrivateClient.getTradingBalance();

    const balance: UserBalance = Object.fromEntries(
      Object.entries(balanceFromExchange).map(
        ([asset, assetBalance]) => [
          asset,
          {
            available: assetBalance.available,
            freeze: assetBalance.freeze,
          },
        ],
      ),
    );

    userBalanceStore.setBalance(userId, balance);
  } catch (error) {
    console.error('syncUserBalance failed', error);
    userBalanceStore.setUnknown(userId);
  } finally {
    isSyncing = false;
  }
};

export const invalidateAndRefreshUserBalance = (
  userId: number,
): void => {
  userBalanceStore.setUnknown(userId);

  void syncUserBalance(userId);
};
