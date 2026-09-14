// app/src/server/entities/index.ts

import type { Entities } from '../types/entities.js';
import { candles } from './candles/index.js';
import { indicators } from './indicators/index.js';

export const entities = {
  candles,
  indicators,
} satisfies Entities;
