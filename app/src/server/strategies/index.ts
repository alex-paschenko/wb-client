import { Strategy } from '../types/strategies.js';
import { OneMarketTwoDeals } from './one-market-two-deals.js';

export const strategies = [
  new OneMarketTwoDeals({
    longCandidateTreshold: 2.25,
    shortCandidateTreshold: -2.25,
    longReturnToIdleTreshold: 2.0,
    shortReturnToIdleTreshold: -2.0,
    longOpenDealTreshold: 2.5,
    shortOpenDealTreshold: -2.5,
    longCloseDealTreshold: -1.5,
    shortCloseDealTreshold: 1.5,
  }),
] satisfies Strategy<any>[];
