import { useTranslation } from 'react-i18next';

export const SettingsPage = () => {
  const { t } = useTranslation();

  return (
    <section className="w-full rounded-2xl border border-panel-border bg-panel p-4">
      <h2 className="text-lg font-semibold text-accent">
        {t('settings.title')}
      </h2>

      <p className="mt-2 text-sm text-muted">
        {t('settings.placeholder')}
      </p>
    </section>
  );
};
