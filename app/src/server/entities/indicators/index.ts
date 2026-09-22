// app/src/server/entities/indicators/index.ts

import { MINUTES, SECONDS } from '../../../shared/constants/time.js';
import { AdaptiveEmaIndicator } from './adaptive-ema.js';
import { ContinuousEmaIndicator } from './continuous-ema.js';
import { EmaIndicator } from './ema.js';
import { MarketForecastIndicator } from './market-forecast.js';
import { MarketPhaseIndicator } from './market-phase.js';

const emaPeriods = [20, 50, 90, 200];

const filterTaus = [
  20 * SECONDS,
  50 * SECONDS,
  90 * SECONDS,
  3 * MINUTES,
];

const phaseResponseTime = 30 * SECONDS;

export const indicators = [
  ...emaPeriods.map((period) => new EmaIndicator({ period })),

  ...filterTaus.map((tau) => new ContinuousEmaIndicator({ tau })),

  ...filterTaus.map((tau) => new AdaptiveEmaIndicator({
    tau,
    minTau: tau / 10,
    sensitivity: 1,
  })),

  new MarketPhaseIndicator({
    responseTime: phaseResponseTime,
    surpriseTau: 5 * MINUTES,
  }),

  new MarketForecastIndicator({ responseTime: phaseResponseTime }),
];
