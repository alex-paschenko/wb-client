// app/src/client/src/components/IndicatorSettings.tsx

import {
  memo,
  useCallback,
  type ChangeEvent,
} from 'react';
import {
  useTranslation,
} from 'react-i18next';

import {
  ColorPicker,
} from './ColorPicker';
import {
  truncateMiddle,
} from '../utilities/string';

interface IndicatorSettingsProps {
  indicatorName: string;
  color: string;
  isVisible: boolean;

  onVisibleChange: (
    indicatorName: string,
    isVisible: boolean,
  ) => void;

  onColorChange: (
    indicatorName: string,
    color: string,
  ) => void;
}

export const IndicatorSettings = memo(({
  indicatorName,
  color,
  isVisible,
  onVisibleChange,
  onColorChange,
}: IndicatorSettingsProps) => {
  const { t } = useTranslation();

  const handleVisibleChange =
    useCallback((
      event: ChangeEvent<HTMLInputElement>,
    ) => {
      onVisibleChange(
        indicatorName,
        event.target.checked,
      );
    }, [
      indicatorName,
      onVisibleChange,
    ]);

  const handleColorChange = useCallback(
    (nextColor: string) => {
      onColorChange(
        indicatorName,
        nextColor,
      );
    }, [
      indicatorName,
      onColorChange,
    ]);

  const displayName = truncateMiddle(indicatorName, 16);

  return (
    <div className="settings-row settings-row-checkbox w-64">
      <input
        type="checkbox"
        checked={isVisible}
        aria-label={t(
          'settings.indicators.visibilityAriaLabel',
          {
            name: indicatorName,
          },
        )}
        onChange={handleVisibleChange}
      />

      <ColorPicker
        color={color}
        onChange={handleColorChange}
        ariaLabel={t(
          'settings.indicators.colorAriaLabel',
          {
            name: indicatorName,
          },
        )}
      />

      <span
        className={
          'min-w-0 whitespace-nowrap text-sm text-fg'}
        title={indicatorName}
      >
        {displayName}
      </span>

    </div>
  );
});

IndicatorSettings.displayName =
  'IndicatorSettings';
