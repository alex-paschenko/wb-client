import type { FrontendSettings } from '../../../shared/types/frontend-settings';

import { apiRequest } from './http';

interface SettingsResponse {
  ok: true;
  settings: FrontendSettings;
}

export const settingsApi = {
  get: () =>
    apiRequest<SettingsResponse>('/settings'),

  save: (settings: FrontendSettings) =>
    apiRequest<SettingsResponse>('/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
};
