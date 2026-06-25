export type SignalSide = 'none' | 'buy' | 'sell';

export interface StrategySignalState {
  strategy: string;
  symbol: string;
  side: SignalSide;
  reason?: string;
  price: number;
  exchangeTimestampMs: number;
  meta?: Record<string, unknown>;
}

export interface StrategySignalBucket {
  prev: StrategySignalState;
  current: StrategySignalState;
}

export interface SignalChangedEvent {
  type: 'signal-changed';
  strategy: string;
  symbol: string;
  side: SignalSide;
  price: number | null;
  exchangeTimestampMs: number;
}
