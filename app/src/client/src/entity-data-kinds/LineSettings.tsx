// app/src/client/src/entity-data-kinds/LineSettings.tsx

import {
  useCallback,
  type ChangeEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { ColorPicker } from '../components/ColorPicker';
import { useAppContext } from '../contexts/AppContext';
import { truncateMiddle } from '../utilities/string';
import type { EntityDataKind } from
  '../../../shared/constants/storage-entities';
import type { EntityDataKindSettingsProps } from './types';
import type { LineEntitySettings } from './settings-types';

interface LineSettingsProps extends EntityDataKindSettingsProps {
  dataKind: EntityDataKind;

  getSettings: (
    entityIndex: number,
  ) => LineEntitySettings;

  setSettings: (
    value: LineEntitySettings,
  ) => void;
}

export const LineSettings = ({
  descriptor,
  entityIndex,
  dataKind,
  getSettings,
  setSettings,
}: LineSettingsProps) => {
  const { t } = useTranslation();

  const value = getSettings(entityIndex);

  const handleVisibleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setSettings({
        ...value,
        isVisible: event.target.checked,
      });
    },
    [setSettings, value],
  );

  const handleColorChange = useCallback(
    (color: string) => {
      setSettings({
        ...value,
        color,
      });
    },
    [setSettings, value],
  );

  const displayName = truncateMiddle(descriptor.name, 16);

  return (
    <div className="settings-row settings-row-checkbox w-64">
      <input
        type="checkbox"
        checked={value.isVisible}
        aria-label={t('settings.entity.visibilityAriaLabel', {
          name: descriptor.name,
          dataKind,
        })}
        onChange={handleVisibleChange}
      />

      <ColorPicker
        color={value.color}
        onChange={handleColorChange}
        ariaLabel={t('settings.entity.colorAriaLabel', {
          name: descriptor.name,
          dataKind,
        })}
      />

      <span
        className="min-w-0 whitespace-nowrap text-sm text-fg"
        title={descriptor.name}
      >
        {displayName}
        {' · '}
        {t(`settings.dataKind.${dataKind}`)}
      </span>
    </div>
  );
};
