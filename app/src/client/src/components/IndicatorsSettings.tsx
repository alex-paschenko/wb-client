// app/src/client/src/components/IndicatorsSettings.tsx

import {
  useCallback,
  useMemo,
} from 'react';
import {
  useTranslation,
} from 'react-i18next';

import {
  IndicatorSettings,
} from './IndicatorSettings';
import {
  useAppContext,
} from '../contexts/AppContext';
import { SettingsSection } from './SettingsSection';

export const IndicatorsSettings = () => {
  const { t } = useTranslation();

  const {
    settings,
    setIndicatorColor,
    setIndicatorVisible,
  } = useAppContext();

  const indicators = useMemo(
    () => {
      const settingsValue =
        settings.toValue();

      return Object.entries(
        settingsValue.indicators,
      ).sort(
        ([firstName], [secondName]) =>
          firstName.localeCompare(
            secondName,
          ),
      );
    },
    [settings],
  );

  const handleVisibleChange =
    useCallback((
      indicatorName: string,
      isVisible: boolean,
    ) => {
      setIndicatorVisible(
        indicatorName,
        isVisible,
      );
    }, [
      setIndicatorVisible,
    ]);

  const handleColorChange =
    useCallback((
      indicatorName: string,
      color: string,
    ) => {
      setIndicatorColor(
        indicatorName,
        color,
      );
    }, [
      setIndicatorColor,
    ]);

  return (
    <SettingsSection title={t('settings.indicators.title')}>
      {indicators.length > 0
        ? (
          <div className="flex flex-wrap gap-2">
            {indicators.map(([
              indicatorName,
              indicatorSettings,
            ]) => (
              <IndicatorSettings
                key={indicatorName}
                indicatorName={indicatorName}
                color={indicatorSettings.color}
                isVisible={indicatorSettings.isVisible}
                onVisibleChange={handleVisibleChange}
                onColorChange={handleColorChange}
              />
            ))}
          </div>
        )
        : (
          <p className="text-sm text-muted">
            {t('settings.indicators.empty')}
          </p>
        )}
    </SettingsSection>
  );
};
