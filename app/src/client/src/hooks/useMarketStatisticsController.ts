// app/src/client/src/hooks/useMarketStatisticsController.ts
import {
  useMemo,
} from 'react';

import {
  controllerRegistry,
} from '../services/controller-registry';

export const useMarketStatisticsController = (
  marketName: string,
) =>
  useMemo(
    () =>
      controllerRegistry.getMarketStatisticsController(
        marketName,
      ),
    [marketName],
  );
