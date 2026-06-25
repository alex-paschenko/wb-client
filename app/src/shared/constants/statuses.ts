export const botStatuses = [
  { name: 'starting' },
  { name: 'running' },
  { name: 'lagging' },
  { name: 'degraded' },
  { name: 'stopping' },
  { name: 'stopped' },
  { name: 'failed' },
] as const;

export type BotStatus = (typeof botStatuses)[number]['name'];

export const strategyStatuses = [
  { name: 'starting' },
  { name: 'running' },
  { name: 'paused' },
  { name: 'waiting_signal' },
  { name: 'placing_order' },
  { name: 'stopping' },
  { name: 'stopped' },
  { name: 'failed' },
] as const;

export type StrategyStatus = (typeof strategyStatuses)[number]['name'];
