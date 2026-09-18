// app/src/shared/constants/market-statistics-storage.ts

import { MINUTE } from './time.js';

const PERMILLE = 1000;
const PER_MINUTE = 1 * MINUTE;

export const RELATIVE_SPEED_SCALE = PERMILLE * PER_MINUTE;
export const TIME_DERIVATIVE_SCALE = PER_MINUTE;
