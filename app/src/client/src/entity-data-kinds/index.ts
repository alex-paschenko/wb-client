// app/src/client/src/entity-data-kinds/index.ts

import type {
  EntityDataKind,
} from '../../../shared/constants/storage-entities';
import { accelerationLineDataKindHandler } from './acceleration-line';
import { lineDataKindHandler } from './line';
import { ohlcDataKindHandler } from './ohlc';
import { priceLineDataKindHandler } from './price-line';
import { speedLineDataKindHandler } from './speed-line';
import type { AnyEntityDataKindHandler } from './types';

export const ENTITY_DATA_KIND_HANDLERS:
  Record<EntityDataKind, AnyEntityDataKindHandler> = {
    line: lineDataKindHandler,
    ohlc: ohlcDataKindHandler,
    priceLine: priceLineDataKindHandler,
    speedLine: speedLineDataKindHandler,
    accelerationLine: accelerationLineDataKindHandler,
  };
