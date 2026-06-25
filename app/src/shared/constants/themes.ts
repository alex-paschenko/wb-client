export const themes = [
  'light',
  'dark',
] as const;

export type Theme =
  (typeof themes)[number];

export const defaultTheme: Theme =
  'dark';

export const isTheme = (
  value: unknown,
): value is Theme =>
  typeof value === 'string' &&
  themes.includes(value as Theme);
