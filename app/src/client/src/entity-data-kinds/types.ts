// app/src/client/src/entity-data-kinds/types.ts

import type { ComponentType } from 'react';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { EntityDataKind } from '../../../shared/constants/storage-entities';
import type { FrontendSettings } from '../../../shared/services/frontend-settings';
import type { StorageAccessors } from '../../../shared/types/storage';
import type { EntityDesriptor } from '../../../shared/types/storage-entities';

export interface EntityDataKindSettingsProps {
  descriptor: EntityDesriptor;
  entityIndex: number;
}

export interface EntitySeriesContext {
  chart: IChartApi;
  panelIndex: number;
  title: string;
}

export interface EntityDataContext {
  accessors: StorageAccessors;
  descriptor: EntityDesriptor;
  index: number;
}

export interface EntityDataKindHandler<
  TSettings = unknown,
  TData = unknown,
  TSeriesType extends SeriesType = SeriesType,
> {
  dataKind: EntityDataKind;

  SettingsComponent: ComponentType<EntityDataKindSettingsProps>;

  getSettings(
    settings: FrontendSettings,
    descriptor: EntityDesriptor,
    entityIndex: number,
  ): TSettings;

  setSettings(
    settings: FrontendSettings,
    descriptor: EntityDesriptor,
    value: TSettings,
  ): void;

  isVisible(settings: TSettings): boolean;

  getData(context: EntityDataContext): TData;

  createSeries(
    context: EntitySeriesContext,
    settings: TSettings,
  ): ISeriesApi<TSeriesType>;

  applySettings(
    series: ISeriesApi<TSeriesType>,
    settings: TSettings,
  ): void;

  setData(
    series: ISeriesApi<TSeriesType>,
    data: TData[],
  ): void;

  updateSeries(
    series: ISeriesApi<TSeriesType>,
    data: TData,
  ): void;
}

export type AnyEntityDataKindHandler = EntityDataKindHandler<any, any, any>;