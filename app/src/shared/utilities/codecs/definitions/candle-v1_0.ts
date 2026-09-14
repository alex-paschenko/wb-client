// app/src/shared/utilities/codecs/definitions/candle-v1_0.ts

import { MarketCandle } from '../../../types/data-types';
import { fixedCountArrayCodecDefinition } from './codec-definition-helpers';

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

export const candle_V1_0 = fixedCountArrayCodecDefinition<MarketCandle>({
  fieldSet: [
    { fieldName: 'receivedAt', codec: 'float64 (nullable) v1.0' },
    { fieldName: 'price', codec: 'float64 (nullable) v1.0' },
    { fieldName: 'speed', codec: 'float64 (nullable) v1.0' },
    { fieldName: 'acceleration', codec: 'float64 (nullable) v1.0' },
    { fieldName: 'startedAt', codec: 'float64 (nullable) v1.0' },
    { fieldName: 'endedAt', codec: 'float64 (nullable) v1.0' },
    { fieldName: 'open', codec: 'float64 (nullable) v1.0' },
    { fieldName: 'close', codec: 'float64 (nullable) v1.0' },
    { fieldName: 'high', codec: 'float64 (nullable) v1.0' },
    { fieldName: 'low', codec: 'float64 (nullable) v1.0' },
  ],
});
