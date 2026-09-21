// app/src/client/src/components/OhlcEntitySettings.tsx

import { useCallback, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  EntityDesriptor,
  OhlcDataDescriptor,
} from '../../../shared/types/storage-entities';
import { useAppContext } from '../contexts/AppContext';
import {
  getEntityDataKey,
  getOhlcEntitySettings,
} from '../entity-data/utilities';
import { truncateMiddle } from '../utilities/string';

interface OhlcEntitySettingsProps {
  descriptor: EntityDesriptor;
  data: OhlcDataDescriptor;
}

export const OhlcEntitySettings = ({
  descriptor,
  data,
}: OhlcEntitySettingsProps) => {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppContext();

  const dataKey = getEntityDataKey(data);
  const value = getOhlcEntitySettings(
    settings,
    descriptor,
    data,
  );

  const dataName = t(`settings.dataKind.${dataKey}`);

  const handleVisibleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      updateSettings((nextSettings) => {
        nextSettings.setEntityDataSettings(
          descriptor.kind,
          descriptor.name,
          dataKey,
          {
            isVisible: event.target.checked,
          },
        );
      });
    },
    [dataKey, descriptor, updateSettings],
  );

  const displayName = truncateMiddle(descriptor.name, 16);

  return (
    <div className="settings-row settings-row-checkbox w-64">
      <input
        type="checkbox"
        checked={value.isVisible}
        aria-label={t('settings.entity.visibilityAriaLabel', {
          name: descriptor.name,
          dataKind: dataName,
        })}
        onChange={handleVisibleChange}
      />

      <span
        className="min-w-0 whitespace-nowrap text-sm text-fg"
        title={descriptor.name}
      >
        {displayName}
        {' · '}
        {dataName}
      </span>
    </div>
  );
};
