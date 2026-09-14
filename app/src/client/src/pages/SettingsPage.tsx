// app/src/client/src/pages/SettingsPage.tsx

import { useTranslation } from 'react-i18next';

import { STORAGE_ENTITY_KINDS } from
  '../../../shared/constants/storage-entities';
import { SettingsSection } from '../components/SettingsSection';
import { useAppContext } from '../contexts/AppContext';
import { ENTITY_DATA_KIND_HANDLERS } from '../entity-data-kinds';

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
                      return descriptor.dataKind.map((dataKind) => {
                        const handler =
                          ENTITY_DATA_KIND_HANDLERS[dataKind];

                        const SettingsComponent =
                          handler.SettingsComponent;

                        return (
                          <SettingsComponent
                            key={`${descriptor.name}:${dataKind}`}
                            descriptor={descriptor}
                            entityIndex={entityIndex}
                          />
                        );
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
