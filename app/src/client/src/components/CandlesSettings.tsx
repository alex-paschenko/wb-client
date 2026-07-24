// app/src/client/src/components/CandlesSettings.tsx

import { useTranslation } from 'react-i18next';

import { ColorPicker } from './ColorPicker';
import { SettingsSection } from './SettingsSection';

import { useAppContext } from '../contexts/AppContext';

export const CandlesSettings = () => {
  const { t } = useTranslation();

  const { settings, setCandleColor } = useAppContext();

  return (
    <SettingsSection
      title={t('settings.candles.title')}
    >
      <div className="settings-row settings-row-simple w-64">
        <span>
          {t('settings.candles.lineColor')}
        </span>

        <ColorPicker
          color={ settings.getCandleColor() }
          onChange={ setCandleColor }
          ariaLabel={t('settings.candles.lineColorAriaLabel')}
        />
      </div>
    </SettingsSection>
  );
};
