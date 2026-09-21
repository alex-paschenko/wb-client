// app/src/shared/constants/frontend-settings.ts

import { STORAGE_ENTITY_KINDS } from './storage-entities.js';
import { defaultTheme } from './themes.js';
import { defaultLanguage } from '../i18n/languages.js';
import type {
  EntitiesSettings,
  EntityDataSettings,
  FrontendSettingsValue,
} from '../types/frontend-settings.js';
import type {
  WritableStorageStructure,
} from '../types/storage.js';

export const ENTITY_COLORS = [
  '#2962ff',
  '#f59e0b',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899',
  '#22c55e',
  '#f97316',
  '#6366f1',
  '#14b8a6',
  '#eab308',
  '#ef4444',
] as const;

export const getEntityColor = (colorIndex: number): string =>
  ENTITY_COLORS[colorIndex % ENTITY_COLORS.length];

export const createEmptyEntitiesSettings = (): EntitiesSettings => {
  const result = {} as WritableStorageStructure<EntityDataSettings>;

  for (const kind of STORAGE_ENTITY_KINDS) {
    result[kind] = {};
  }

  return result;
};

export const defaultFrontendSettings: FrontendSettingsValue = {
  theme: defaultTheme,
  language: defaultLanguage,
  marketsViewStates: [],
  entities: createEmptyEntitiesSettings(),
};
