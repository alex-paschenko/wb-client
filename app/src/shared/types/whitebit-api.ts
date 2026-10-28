import type { MarketType } from './market.js';

/********
 * REST *
 ********/


export interface WhitebitMarket {
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
  maxTotal: string;
  tradesEnabled: boolean;
  isCollateral: boolean;
  isTradFiFutures: boolean;
  type: MarketType;
  delistedAt: number | null;
  tickSize: string;
  stepSize: string;
}

/************
 * Websoket *
 ************/

// Market Statistics

export interface WhitebitMarketStatistics {
    period: number;
    last: string;
    open: string;
    close: string;
    high: string;
    low: string;
    volume: string; // stock currency volume
    deal: string;   // money currency volume
}

export type WhitebitMarketStatisticsField = keyof WhitebitMarketStatistics;

export const WHITEBIT_MARKET_STATISTICS_FIELDS = [
    'period',
    'last',
    'open',
    'close',
    'high',
    'low',
    'volume',
    'deal',
] as const satisfies readonly WhitebitMarketStatisticsField[];

export interface WhitebitWSBaseMessage extends Record<string, unknown> {
  id: number | null;
}

export interface WhitebitMarketUpdateMessage extends WhitebitWSBaseMessage {
  id: null;
  method: 'market_update';
  params: [
    marketName: string,
    statistics: WhitebitMarketStatistics,
  ];
}

