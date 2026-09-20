import type { MarketPhaseValue } from '../../../types/data-types';
import { fixedCountArrayCodecDefinition } from './codec-definition-helpers';

/*
 * IMPORTANT:
 * This codec version is immutable once released.
 * Never change its binary format.
 * Create a new codec version instead.
 */

export const marketPhase_V1_0 =
  fixedCountArrayCodecDefinition<MarketPhaseValue>({
    fieldSet: [
      { fieldName: 'position', codec: 'float64 (nullable) v1.0' },
      { fieldName: 'speed', codec: 'float64 (nullable) v1.0' },
      { fieldName: 'acceleration', codec: 'float64 (nullable) v1.0' },
    ],
  });
