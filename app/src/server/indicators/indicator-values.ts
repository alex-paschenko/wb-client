// app/src/server/indicators/indicator-values.ts
import type {
  IndicatorValue,
} from '../../shared/types/market-indicators.js';
import type {
  AggregatedItemDescriptor,
} from '../../shared/types/market-statistics-storage.js';

export const getLastRemovedIndicatorValue = (
  descriptor: AggregatedItemDescriptor,
  indicatorName: string,
): IndicatorValue =>
  descriptor.removedIndicators[indicatorName]?.at(-1) ?? null;
