// app/src/shared/types/market.ts

export type MarketType = 'spot' | 'futures' | 'tradfiFutures';

export interface Market {
  name: string;
  stock: string;
  money: string;
  stockPrec: number;
  moneyPrec: number;
  feePrec: number;
  makerFee: number;
  takerFee: number;
  minAmount: number;
  minTotal: number;
  maxTotal: number;
  tradesEnabled: boolean;
  isActive: boolean;
  isCollateral: boolean;
  isTradFiFutures: boolean;
  type: MarketType;
  tickSize: number | null;
  stepSize: number | null;
  delistedAt: number | null;
}

export type MarketsByName = Record<string, Market>;

export interface MarketFee {
  makerFeeRatio: number;
  takerFeeRatio: number;
  rpiMakerFeePremiumRatio: number | null;
}

export type MarketFeesByName = Record<string, MarketFee>;
