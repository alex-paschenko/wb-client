import {
  useMemo,
} from 'react';

import {
  MARKET_STATISTICS_LEVEL_DURATIONS,
} from '../../../shared/constants/market-statistics-config';

import {
  MarketStatisticsController,
} from '../controllers/MarketStatisticsController';

const defaultDuration = MARKET_STATISTICS_LEVEL_DURATIONS[0];

export const useMarketStatisticsController = (
  marketName: string,
): MarketStatisticsController => {
  return useMemo(() => {
    return new MarketStatisticsController(
      marketName,
      {
        interval: defaultDuration.interval,
      },
    );
  }, [marketName]);
};
