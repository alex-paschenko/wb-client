import { Strategy } from '../types/strategies.js';
import { OneMarketTwoDeals } from './one-market-two-deals.js';

export const strategies = [
  new OneMarketTwoDeals({
    candidateTreshold: 2.25,
  }),
] satisfies Strategy<any>[];
