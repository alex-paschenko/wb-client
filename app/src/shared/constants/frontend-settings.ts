import { defaultTheme } from './themes.js';
import { defaultLanguage } from '../i18n/languages.js';

import type { FrontendSettings } from '../types/frontend-settings.js';

export const defaultFrontendSettings: FrontendSettings = {
  theme: defaultTheme,
  language: defaultLanguage,
};
