import { StrategyEngine } from './strategy-engine.js';
import { MomentumReversalStrategy } from './strategies/momentum-reversal.js';

export const strategyEngine = new StrategyEngine([
  new MomentumReversalStrategy(),
]);
