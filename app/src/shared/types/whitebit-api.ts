import type { Market } from './market.js';

/********
 * REST *
 ********/


export type WhitebitMarket = Omit<Market, 'isActive' | 'createdAt' | 'updatedAt'>;

export const whitebitMarketKeys = [
  'name',
  'stock',
  'money',
  'stockPrec',
  'moneyPrec',
  'feePrec',
  'makerFee',
  'takerFee',
  'minAmount',
  'minTotal',
  'tradesEnabled',
  'type',
  'maxTotal',
  'isCollateral',
] as const;

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

