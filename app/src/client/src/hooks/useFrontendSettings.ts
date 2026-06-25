import { useEffect, useState } from 'react';

import { defaultFrontendSettings } from '../../../shared/constants/frontend-settings';
import type { FrontendSettings } from '../../../shared/types/frontend-settings';

import { settingsApi } from '../api/settings-api';

export function useFrontendSettings() {
  const [settings, setSettings] =
    useState<FrontendSettings>(defaultFrontendSettings);

  const [isLoading, setIsLoading] =
    useState(true);

  const [error, setError] =
    useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    void settingsApi
      .get()
      .then((response) => {
        if (!isMounted) {
          return;
        }

        setSettings(response.settings);
      })
      .catch((unknownError) => {
        if (!isMounted) {
          return;
        }

        setError(
          unknownError instanceof Error
            ? unknownError.message
            : 'Failed to load settings',
        );
      })
      .finally(() => {
        if (!isMounted) {
          return;
        }

        setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const saveSettings = async (
    nextSettings: FrontendSettings,
  ): Promise<void> => {
    setSettings(nextSettings);
    setError(null);

    try {
      const response =
        await settingsApi.save(nextSettings);

      setSettings(response.settings);
    } catch (unknownError) {
      setError(
        unknownError instanceof Error
          ? unknownError.message
          : 'Failed to save settings',
      );
    }
  };

  return {
    settings,
    isLoading,
    error,
    saveSettings,
  };
}
