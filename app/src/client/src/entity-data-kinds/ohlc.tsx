// app/src/client/src/entity-data-kinds/ohlc.tsx

import { CandlestickSeries, type CandlestickData } from 'lightweight-charts';
import { useCallback, type ChangeEvent } from 'react';

import type { MarketCandle } from '../../../shared/types/data-types';
import type { LazyArray } from '../../../shared/utilities/lazy-array';
import { getEntityChartTime } from './utilities';
import { useTranslation } from 'react-i18next';
import type { FrontendSettings } from '../../../shared/services/frontend-settings';
import type { EntityDesriptor } from '../../../shared/types/storage-entities';
import { useAppContext } from '../contexts/AppContext';
import { truncateMiddle } from '../utilities/string';
import type { OhlcEntitySettings } from './settings-types';
import type {
  EntityDataContext,
  EntityDataKindHandler,
  EntityDataKindSettingsProps,
} from './types';

const DATA_KIND = 'ohlc' as const;

const getSettings = (
  settings: FrontendSettings,
  descriptor: EntityDesriptor,
): OhlcEntitySettings => {
  const stored = settings.getEntityDataKindSettings<OhlcEntitySettings>(
    descriptor.kind,
    descriptor.name,
    DATA_KIND,
  );

  return {
    isVisible: stored?.isVisible ?? true,
  };
};

const setSettings = (
  settings: FrontendSettings,
  descriptor: EntityDesriptor,
  value: OhlcEntitySettings,
): void => {
  settings.setEntityDataKindSettings(
    descriptor.kind,
    descriptor.name,
    DATA_KIND,
    value,
  );
};

const getData = ({
  accessors,
  descriptor,
  index,
}: EntityDataContext): CandlestickData => {
  const accessor =
    accessors[descriptor.kind][descriptor.name] as LazyArray<MarketCandle>;

  if (!accessor) {
    throw new Error(
      `Accessor "${descriptor.kind}/${descriptor.name}" not found`,
    );
  }

  return {
    time: getEntityChartTime(accessors, index),
    open: accessor.get(index, 'open'),
    high: accessor.get(index, 'high'),
    low: accessor.get(index, 'low'),
    close: accessor.get(index, 'close'),
  };
};

const SettingsComponent = ({
  descriptor,
}: EntityDataKindSettingsProps) => {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppContext();

  const value = getSettings(settings, descriptor);

  const handleVisibleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      updateSettings((nextSettings) => {
        setSettings(nextSettings, descriptor, {
          isVisible: event.target.checked,
        });
      });
    },
    [descriptor, updateSettings],
  );

  const displayName = truncateMiddle(descriptor.name, 16);

  return (
    <div className="settings-row settings-row-checkbox w-64">
      <input
        type="checkbox"
        checked={value.isVisible}
        aria-label={t('settings.entity.visibilityAriaLabel', {
          name: descriptor.name,
          dataKind: DATA_KIND,
        })}
        onChange={handleVisibleChange}
      />

      <span
        className="min-w-0 whitespace-nowrap text-sm text-fg"
        title={descriptor.name}
      >
        {displayName}
        {' · '}
        {t(`settings.dataKind.${DATA_KIND}`)}
      </span>
    </div>
  );
};

export const ohlcDataKindHandler:
  EntityDataKindHandler<OhlcEntitySettings, CandlestickData, 'Candlestick'> = {
    dataKind: DATA_KIND,
    SettingsComponent,
    getSettings,
    setSettings,
    isVisible: (settings) => settings.isVisible,
    getData,

    createSeries: ({ chart, panelIndex }, settings) => {
      return chart.addSeries(
        CandlestickSeries,
        {
          visible: settings.isVisible,
          priceLineVisible: false,
          lastValueVisible: false,
        },
        panelIndex,
      );
    },

    applySettings: (series, settings) => {
      series.applyOptions({
        visible: settings.isVisible,
      });
    },

    setData: (series, data) => {
      series.setData(data);
    },

    updateSeries: (series, data) => {
      series.update(data);
    },
  };
