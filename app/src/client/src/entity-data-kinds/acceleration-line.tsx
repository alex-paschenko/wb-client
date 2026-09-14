// app/src/client/src/entity-data-kinds/acceleration-line.tsx

import { LineSeries, type LineData } from 'lightweight-charts';

import { getEntityColor } from '../../../shared/constants/frontend-settings';
import type { FrontendSettings } from
  '../../../shared/services/frontend-settings';
import type { MarketCandle } from '../../../shared/types/data-types';
import type { EntityDesriptor } from
  '../../../shared/types/storage-entities';
import type { LazyArray } from '../../../shared/utilities/lazy-array';
import { useAppContext } from '../contexts/AppContext';
import { LineSettings } from './LineSettings';
import type { LineEntitySettings } from './settings-types';
import type {
  EntityDataContext,
  EntityDataKindHandler,
  EntityDataKindSettingsProps,
} from './types';
import { getEntityChartTime } from './utilities';

const DATA_KIND = 'accelerationLine' as const;

const getSettings = (
  settings: FrontendSettings,
  descriptor: EntityDesriptor,
  entityIndex: number,
): LineEntitySettings => {
  const stored = settings.getEntityDataKindSettings<LineEntitySettings>(
    descriptor.kind,
    descriptor.name,
    DATA_KIND,
  );

  return {
    color: stored?.color ?? getEntityColor(entityIndex),
    isVisible: stored?.isVisible ?? true,
  };
};

const setSettings = (
  settings: FrontendSettings,
  descriptor: EntityDesriptor,
  value: LineEntitySettings,
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
}: EntityDataContext): LineData => {
  const accessor =
    accessors[descriptor.kind][descriptor.name] as LazyArray<MarketCandle>;

  if (!accessor) {
    throw new Error(
      `Accessor "${descriptor.kind}/${descriptor.name}" not found`,
    );
  }

  return {
    time: getEntityChartTime(accessors, index),
    value: accessor.get(index, 'acceleration'),
  };
};

const SettingsComponent = ({
  descriptor,
  entityIndex,
}: EntityDataKindSettingsProps) => {
  const { settings, updateSettings } = useAppContext();

  return (
    <LineSettings
      descriptor={descriptor}
      entityIndex={entityIndex}
      dataKind={DATA_KIND}
      getSettings={() => getSettings(settings, descriptor, entityIndex)}
      setSettings={(value) => {
        updateSettings((nextSettings) => {
          setSettings(nextSettings, descriptor, value);
        });
      }}
    />
  );
};

export const accelerationLineDataKindHandler:
  EntityDataKindHandler<LineEntitySettings, LineData, 'Line'> = {
    dataKind: DATA_KIND,
    SettingsComponent,
    getSettings,
    setSettings,
    isVisible: (settings) => settings.isVisible,
    getData,

    createSeries: ({ chart, panelIndex }, settings) => {
      return chart.addSeries(
        LineSeries,
        {
          color: settings.color,
          lineWidth: 1,
          visible: settings.isVisible,
          priceLineVisible: false,
          lastValueVisible: true,
        },
        panelIndex,
      );
    },

    applySettings: (series, settings) => {
      series.applyOptions({
        color: settings.color,
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
