// app/src/client/src/entity-data/utilities.ts

import type { UTCTimestamp } from 'lightweight-charts';

import {
  CANDLE_NAME,
} from '../../../shared/constants/storage-entities';
import {
  getEntityColor,
} from '../../../shared/constants/frontend-settings';
import { SECOND } from '../../../shared/constants/time';
import type {
  FrontendSettings,
} from '../../../shared/services/frontend-settings';
import type { MarketCandle } from '../../../shared/types/data-types';
import type { StorageAccessors } from '../../../shared/types/storage';
import type {
  EntityDataDescriptor,
  EntityDesriptor,
} from '../../../shared/types/storage-entities';
import type { LazyArray } from '../../../shared/utilities/lazy-array';
import type {
  LineEntitySettings,
  OhlcEntitySettings,
} from './types';

const ONE_SECOND = 1 * SECOND;

export const getEntityDataKey = (
  data: EntityDataDescriptor,
): string => {
  return data.key
    ? `${data.kind}.${data.key}`
    : data.kind;
};

export const getEntityChartTime = (
  accessors: StorageAccessors,
  index: number,
): UTCTimestamp => {
  const candles =
    accessors.candles[CANDLE_NAME] as LazyArray<MarketCandle>;

  if (!candles) {
    throw new Error('Candle accessor not found');
  }

  const startedAt = candles.get(index, 'startedAt');

  return startedAt / ONE_SECOND as UTCTimestamp;
};

export const getLineEntitySettings = (
  settings: FrontendSettings,
  descriptor: EntityDesriptor,
  data: EntityDataDescriptor & { kind: 'line' },
  colorIndex: number,
): LineEntitySettings => {
  const stored = settings.getEntityDataSettings<LineEntitySettings>(
    descriptor.kind,
    descriptor.name,
    getEntityDataKey(data),
  );

  return {
    color: stored?.color ?? getEntityColor(colorIndex),
    isVisible: stored?.isVisible ?? true,
  };
};

export const getOhlcEntitySettings = (
  settings: FrontendSettings,
  descriptor: EntityDesriptor,
  data: EntityDataDescriptor & { kind: 'ohlc' },
): OhlcEntitySettings => {
  const stored = settings.getEntityDataSettings<OhlcEntitySettings>(
    descriptor.kind,
    descriptor.name,
    getEntityDataKey(data),
  );

  return {
    isVisible: stored?.isVisible ?? true,
  };
};
