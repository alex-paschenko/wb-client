import type { MarketForecastValue } from '../../../types/data-types.js';
import { fixedCountArrayCodecDefinition } from './codec-definition-helpers.js';

/* Immutable binary layout: create a new version for future field changes. */
export const marketForecast_V2_0 =
  fixedCountArrayCodecDefinition<MarketForecastValue>({
    migrate: (_previous, from) => {
      if (from !== 'market forecast v1.0') {
        throw new Error(`Cannot migrate market forecast from ${from}`);
      }
      // The old five-horizon forecast is a different target. Start afresh.
      return {
        expectedResidual1m3Ema: null,
        expectedResidual1m4Ema: null,
        expectedResidual1mCombined: null,
      };
    },
    fieldSet: [
      { fieldName: 'expectedResidual1m3Ema', codec: 'float32 (nullable) v1.0' },
      { fieldName: 'expectedResidual1m4Ema', codec: 'float32 (nullable) v1.0' },
      { fieldName: 'expectedResidual1mCombined', codec: 'float32 (nullable) v1.0' },
    ],
  });
