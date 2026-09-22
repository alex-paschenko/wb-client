// app/src/shared/utilities/codecs/definitions/market-forecast-v1_0.ts

import type { MarketForecastValue } from '../../../types/data-types.js';
import { fixedCountArrayCodecDefinition } from './codec-definition-helpers.js';

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

export const marketForecast_V1_0 =
  fixedCountArrayCodecDefinition<MarketForecastValue>({
    fieldSet: [
      { fieldName: 'expectedReturn10s', codec: 'float32 (nullable) v1.0' },
      { fieldName: 'expectedReturn30s', codec: 'float32 (nullable) v1.0' },
      { fieldName: 'expectedReturn1m', codec: 'float32 (nullable) v1.0' },
      { fieldName: 'expectedReturn2m', codec: 'float32 (nullable) v1.0' },
      { fieldName: 'expectedReturn5m', codec: 'float32 (nullable) v1.0' },
    ],
  });
