export interface MarketRollingStatistics {
  receivedAt: number;
  open: number;
  close: number;
  high: number;
  low: number;

  stockVolume: number;
  moneyVolume: number;
}

export type MarketRollingStatisticsByMarket = Record<
  string,
  MarketRollingStatistics
>;
