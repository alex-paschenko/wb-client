import i18next from 'i18next';

import { defaultLanguage } from '../../shared/i18n/languages.js';
import { i18nResources } from '../../shared/i18n/resources.js';

export const serverI18n = i18next.createInstance();

await serverI18n.init({
  lng: defaultLanguage,
  fallbackLng: defaultLanguage,
  resources: i18nResources,
});
