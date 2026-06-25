export interface MarketFee {
  makerFeeRatio: number;
  takerFeeRatio: number;
  source: 'private' | 'fallback';
}
