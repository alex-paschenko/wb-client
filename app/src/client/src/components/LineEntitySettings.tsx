// app/src/client/src/components/LineEntitySettings.tsx

import {
  useCallback,
  type ChangeEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import type {
  EntityDesriptor,
  LineDataDescriptor,
} from '../../../shared/types/storage-entities';
import { ColorPicker } from './ColorPicker';
import { useAppContext } from '../contexts/AppContext';
import {
  getEntityDataKey,
  getLineEntitySettings,
} from '../entity-data/utilities';
import { truncateMiddle } from '../utilities/string';

interface LineEntitySettingsProps {
  descriptor: EntityDesriptor;
  data: LineDataDescriptor;
  colorIndex: number;
}

export const LineEntitySettings = ({
  descriptor,
  data,
  colorIndex,
}: LineEntitySettingsProps) => {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppContext();

  const dataKey = getEntityDataKey(data);
  const value = getLineEntitySettings(
    settings,
    descriptor,
    data,
    colorIndex,
  );

  const handleVisibleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      updateSettings((nextSettings) => {
        nextSettings.setEntityDataSettings(
          descriptor.kind,
          descriptor.name,
          dataKey,
          {
            ...value,
            isVisible: event.target.checked,
          },
        );
      });
    },
    [dataKey, descriptor, updateSettings, value],
  );

  const handleColorChange = useCallback(
    (color: string) => {
      updateSettings((nextSettings) => {
        nextSettings.setEntityDataSettings(
          descriptor.kind,
          descriptor.name,
          dataKey,
          { ...value, color },
        );
      });
    },
    [dataKey, descriptor, updateSettings, value],
  );

  const displayName = truncateMiddle(descriptor.name, 16);

  const dataName = t(
    data.key
      ? `settings.dataKind.${dataKey}`
      : 'settings.dataKind.line.default',
  );

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

      <ColorPicker
        color={value.color}
        onChange={handleColorChange}
        ariaLabel={t('settings.entity.colorAriaLabel', {
          name: descriptor.name,
          dataKind: dataName,
        })}
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
