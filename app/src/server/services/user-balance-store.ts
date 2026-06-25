import type { AssetBalance, UserBalance } from '../types/user-balance.js';

export class UserBalanceStore {
  private readonly balancesByUserId = new Map<number, UserBalance | null>();

  public setUnknown(userId: number): void {
    this.balancesByUserId.set(userId, null);
  }

  public setBalance(
    userId: number,
    balance: UserBalance,
  ): void {
    this.balancesByUserId.set(userId, balance);
  }

  public getBalance(
    userId: number,
  ): UserBalance | null {
    return this.balancesByUserId.get(userId) ?? null;
  }

  public getAssetBalance(
    userId: number,
    asset: string,
  ): AssetBalance | null {
    return this.getBalance(userId)?.[asset] ?? null;
  }
}

export const userBalanceStore =
  new UserBalanceStore();
