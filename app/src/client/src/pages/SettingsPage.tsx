// app/src/client/src/pages/SettingsPage.tsx

import { useTranslation } from 'react-i18next';

import { STORAGE_ENTITY_KINDS } from
  '../../../shared/constants/storage-entities';
import { LineEntitySettings } from '../components/LineEntitySettings';
import { OhlcEntitySettings } from '../components/OhlcEntitySettings';
import { SettingsSection } from '../components/SettingsSection';
import { useAppContext } from '../contexts/AppContext';
import { getEntityDataKey } from '../entity-data/utilities';

export const SettingsPage = () => {
  const { t } = useTranslation();
  const { entities } = useAppContext();

  return (
    <section
      className={
        'w-full rounded-2xl border border-panel-border bg-panel p-4'
      }
    >
      <h2 className="text-lg font-semibold text-accent">
        {t('settings.title')}
      </h2>

      <div className="mt-5 space-y-6">
        {STORAGE_ENTITY_KINDS.map((kind) => {
          const kindEntities = entities
            .map((descriptor, entityIndex) => ({
              descriptor,
              entityIndex,
            }))
            .filter(({ descriptor }) => descriptor.kind === kind);

          return (
            <SettingsSection
              key={kind}
              title={t(`settings.sectionTitle.${kind}`)}
            >
              {kindEntities.length > 0
                ? (
                  <div className="flex flex-wrap gap-2">
                    {kindEntities.flatMap(({
                      descriptor,
                      entityIndex,
                    }) => {
                      return descriptor.data.map((data, dataIndex) => {
                        const key = [
                          descriptor.name,
                          getEntityDataKey(data),
                          data.group,
                        ].join(':');

                        switch (data.kind) {
                          case 'line':
                            return (
                              <LineEntitySettings
                                key={key}
                                descriptor={descriptor}
                                data={data}
                                colorIndex={entityIndex + dataIndex}
                              />
                            );

                          case 'ohlc':
                            return (
                              <OhlcEntitySettings
                                key={key}
                                descriptor={descriptor}
                                data={data}
                              />
                            );
                        }
                      });
                    })}
                  </div>
                )
                : (
                  <p className="text-sm text-muted">
                    {t('settings.entitiesEmpty')}
                  </p>
                )}
            </SettingsSection>
          );
        })}
      </div>
    </section>
  );
};
