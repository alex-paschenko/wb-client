import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import { defaultLanguage } from '../../../shared/i18n/languages';
import { i18nResources } from '../../../shared/i18n/resources';

export const clientI18n = i18next.createInstance();

void clientI18n
  .use(initReactI18next)
  .init({
    lng: defaultLanguage,
    fallbackLng: defaultLanguage,
    resources: i18nResources,
    interpolation: {
      escapeValue: false,
    },
  });
