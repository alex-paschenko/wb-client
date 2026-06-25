import type { MarketFee } from '../types/market-fee.js';

export class MarketFeeStore {
  private fee: MarketFee | null = null;

  public setFee(fee: MarketFee): void {
    this.fee = fee;
  }

  public getFee(): MarketFee | null {
    return this.fee;
  }

  public clear(): void {
    this.fee = null;
  }
}

export const marketFeeStore = new MarketFeeStore();
