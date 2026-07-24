// app/src/client/src/pages/SettingsPage.tsx

import {
  useTranslation,
} from 'react-i18next';

import {
  CandlesSettings,
} from '../components/CandlesSettings';
import {
  IndicatorsSettings,
} from '../components/IndicatorsSettings';

export const SettingsPage = () => {
  const { t } = useTranslation();

  return (
    <section className="w-full rounded-2xl border border-panel-border bg-panel p-4">
      <h2 className="text-lg font-semibold text-accent">
        {t('settings.title')}
      </h2>

      <div className="mt-5 space-y-6">
        <CandlesSettings />

        <IndicatorsSettings />
      </div>
    </section>
  );
};
