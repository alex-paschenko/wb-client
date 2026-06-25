export const LOG_LEVELS = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
} as const;

export type LogLevel =
  (typeof LOG_LEVELS)[keyof typeof LOG_LEVELS];

export type LogEntry = {
  timestamp: number;
  level: LogLevel;
  body: string;
};
