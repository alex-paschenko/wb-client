// app/src/shared/utilities/codecs/definitions/market-forecast-v1_0.ts

import type { IndicatorValue } from '../../../types/data-types.js';
import { fixedCountArrayCodecDefinition } from './codec-definition-helpers.js';

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

interface LegacyMarketForecastValue {
  expectedReturn10s: IndicatorValue;
  expectedReturn30s: IndicatorValue;
  expectedReturn1m: IndicatorValue;
  expectedReturn2m: IndicatorValue;
  expectedReturn5m: IndicatorValue;
}

export const marketForecast_V1_0 =
  fixedCountArrayCodecDefinition<LegacyMarketForecastValue>({
    fieldSet: [
      { fieldName: 'expectedReturn10s', codec: 'float32 (nullable) v1.0' },
      { fieldName: 'expectedReturn30s', codec: 'float32 (nullable) v1.0' },
      { fieldName: 'expectedReturn1m', codec: 'float32 (nullable) v1.0' },
      { fieldName: 'expectedReturn2m', codec: 'float32 (nullable) v1.0' },
      { fieldName: 'expectedReturn5m', codec: 'float32 (nullable) v1.0' },
    ],
  });
