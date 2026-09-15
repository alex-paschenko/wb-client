// app/src/client/src/entity-data-kinds/utilities.ts

import type { UTCTimestamp } from 'lightweight-charts';

import { CANDLE_NAME } from '../../../shared/constants/storage-entities';
import { SECOND } from '../../../shared/constants/time';
import type { StorageAccessors } from '../../../shared/types/storage';
import type { MarketCandle } from '../../../shared/types/data-types';
import type { LazyArray } from '../../../shared/utilities/lazy-array';

const ONE_SECOND = 1 * SECOND;

export const getEntityChartTime = (
  accessors: StorageAccessors,
  index: number,
): UTCTimestamp => {
  const candles = accessors.candles[CANDLE_NAME] as LazyArray<MarketCandle>;

  if (!candles) {
    throw new Error('Candle accessor not found');
  }

  const startedAt = candles.get(index, 'startedAt');

  return startedAt / ONE_SECOND as UTCTimestamp;
};
