export interface RuntimeMarketPrice {
  rawPrice: number;

  makerBuyPrice: number;
  makerSellPrice: number;

  takerBuyPrice: number;
  takerSellPrice: number;
}

export interface RuntimeTick {
  symbol: string;
  price: RuntimeMarketPrice;
  exchangeTimestampMs: number;
}
