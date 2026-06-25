export type StrategySignalType =
  | 'buy'
  | 'sell'
  | 'none';

export interface StrategySignal {
  type: StrategySignalType;

  // TODO: Decide whether confidence should be required.
  confidence?: number;

  // TODO: Maybe replace free-form reason with structured decision details.
  reason?: string;
}
