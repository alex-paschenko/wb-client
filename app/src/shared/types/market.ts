
export type MarketType =
  | 'spot'
  | 'futures'
  | 'tradfiFutures';

export interface Market {
  name: string;
  stock: string;
  money: string;
  stockPrec: string;
  moneyPrec: string;
  feePrec: string;
  makerFee: string;
  takerFee: string;
  minAmount: string;
  minTotal: string;
  tradesEnabled: boolean;
  isActive: boolean;
  type: MarketType;
  maxTotal?: string;
  isCollateral?: boolean;
}

export type MarketsByName = Record<string, Market>;
