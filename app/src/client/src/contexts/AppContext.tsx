import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

import { FrontendSettings } from '../../../shared/services/frontend-settings';
import type {
  FrontendSettingsValue,
} from '../../../shared/types/frontend-settings';
import {
  LOG_LEVELS,
  type LogEntry,
  type LogLevel,
} from '../../../shared/types/logger';
import type {
  MarketsByName,
} from '../../../shared/types/market';
import { appEvents } from '../events/app-events';

type AppLogger = {
  debug: (body: string) => void;
  info: (body: string) => void;
  warn: (body: string) => void;
  error: (body: string) => void;
  addEntry: (
    level: LogLevel,
    timestamp: number,
    body: string,
  ) => void;
};

export type AppContextValue = {
  markets: MarketsByName;
  settings: FrontendSettings;
  logs: LogEntry[];

  setTheme: (theme: string) => void;
  setLanguage: (language: string) => void;
  setMarkets: (markets: MarketsByName) => void;
  applySettingsFromServer: (settings: FrontendSettings) => void;
  updateSettings: (settings: FrontendSettings) => void;

  logger: AppLogger;
};

const AppContext = createContext<AppContextValue | null>(null);

export const AppProvider = ({
  children,
}: {
  children: ReactNode;
}) => {
  const [markets, setMarketsState] = useState<MarketsByName>({});
  const [settingsValue, setSettingsValue] =
    useState<FrontendSettingsValue>(
      FrontendSettings.createDefault().toValue(),
    );
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const settings = useMemo(
    () => FrontendSettings.fromValue(settingsValue),
    [settingsValue],
  );

  const applySettingsFromServer = useCallback((
    nextSettings: FrontendSettings,
  ) => {
    setSettingsValue(nextSettings.toValue());
  }, []);

  const updateSettingsValue = useCallback((
    updater: (settings: FrontendSettings) => void,
  ) => {
    setSettingsValue((currentSettingsValue) => {
      const nextSettings = FrontendSettings.fromValue(currentSettingsValue);

      updater(nextSettings);

      appEvents.emit('settingsChanged', nextSettings);

      return nextSettings.toValue();
    });
  }, []);

  const updateSettings = useCallback((nextSettings: FrontendSettings) => {
    setSettingsValue(nextSettings.toValue());
    appEvents.emit('settingsChanged', nextSettings);
  }, []);

  const setTheme = useCallback((theme: string) => {
    updateSettingsValue((nextSettings) => {
      nextSettings.setTheme(theme);
    });
  }, [updateSettingsValue]);

  const setLanguage = useCallback((language: string) => {
    updateSettingsValue((nextSettings) => {
      nextSettings.setLanguage(language);
    });
  }, [updateSettingsValue]);

  const setMarkets = useCallback((nextMarkets: MarketsByName) => {
    setMarketsState(nextMarkets);

    setSettingsValue((currentSettingsValue) => {
      const nextSettings = FrontendSettings.fromValue(currentSettingsValue);
      const hasChanges = nextSettings.ensureMarkets(nextMarkets);

      if (hasChanges) {
        appEvents.emit('settingsChanged', nextSettings);
      }

      return nextSettings.toValue();
    });
  }, []);

  const addEntry = useCallback((
    level: LogLevel,
    timestamp: number,
    body: string,
  ) => {
    setLogs((currentLogs) => [
      ...currentLogs,
      {
        timestamp,
        level,
        body,
      },
    ]);
  }, []);

  const logger = useMemo<AppLogger>(() => ({
    debug: (body: string) => {
      addEntry(LOG_LEVELS.debug, Date.now(), body);
    },
    info: (body: string) => {
      addEntry(LOG_LEVELS.info, Date.now(), body);
    },
    warn: (body: string) => {
      addEntry(LOG_LEVELS.warn, Date.now(), body);
    },
    error: (body: string) => {
      addEntry(LOG_LEVELS.error, Date.now(), body);
    },
    addEntry,
  }), [addEntry]);

  const value = useMemo<AppContextValue>(() => ({
    markets,
    settings,
    logs,
    setTheme,
    setLanguage,
    setMarkets,
    applySettingsFromServer,
    updateSettings,
    logger,
  }), [
    markets,
    settings,
    logs,
    setMarkets,
    applySettingsFromServer,
    updateSettings,
    logger,
  ]);

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = (): AppContextValue => {
  const value = useContext(AppContext);

  if (!value) {
    throw new Error('AppContext is not initialized');
  }

  return value;
};
