export type FrontendTheme = 'light' | 'dark';

export type FrontendLanguage = 'ru' | 'en';

export interface FrontendSettings {
  theme: FrontendTheme;
  language: FrontendLanguage;
}
