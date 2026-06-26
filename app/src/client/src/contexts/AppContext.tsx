import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

import { FrontendSettings } from '../../../shared/services/frontend-settings';
import {
  MARKET_VIEW_STATES,
  type FrontendSettingsValue,
  type MarketViewState,
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

  getSettings: () => FrontendSettings;
  getMarkets: () => MarketsByName;

  setTheme: (theme: string) => void;
  setLanguage: (language: string) => void;
  setMarkets: (markets: MarketsByName) => void;
  setMarketViewState: (
    marketName: string,
    state: MarketViewState,
  ) => void;
  openMarket: (marketName: string) => void;
  closeMarket: (marketName: string) => void;
  moveMarket: (marketName: string, targetIndex: number) => void;
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

  const marketsRef = useRef<MarketsByName>(markets);
  const settingsValueRef = useRef<FrontendSettingsValue>(settingsValue);

  const settings = useMemo(
    () => FrontendSettings.fromValue(settingsValue),
    [settingsValue],
  );

  const getSettings = useCallback((): FrontendSettings => {
    return FrontendSettings.fromValue(settingsValueRef.current);
  }, []);

  const getMarkets = useCallback((): MarketsByName => {
    return marketsRef.current;
  }, []);

  const applySettingsFromServer = useCallback((
    nextSettings: FrontendSettings,
  ) => {
    const nextValue = nextSettings.toValue();

    settingsValueRef.current = nextValue;
    setSettingsValue(nextValue);
  }, []);

  const updateSettingsValue = useCallback((
    updater: (settings: FrontendSettings) => void,
  ) => {
    const nextSettings = FrontendSettings.fromValue(settingsValueRef.current);

    updater(nextSettings);

    const nextValue = nextSettings.toValue();

    settingsValueRef.current = nextValue;
    setSettingsValue(nextValue);

    appEvents.emit('settingsChanged', nextSettings);
  }, []);

  const updateSettings = useCallback((nextSettings: FrontendSettings) => {
    const nextValue = nextSettings.toValue();

    settingsValueRef.current = nextValue;
    setSettingsValue(nextValue);

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
    marketsRef.current = nextMarkets;
    setMarketsState(nextMarkets);

    const nextSettings = FrontendSettings.fromValue(settingsValueRef.current);
    const hasChanges = nextSettings.ensureMarkets(nextMarkets);

    if (!hasChanges) {
      return;
    }

    const nextValue = nextSettings.toValue();

    settingsValueRef.current = nextValue;
    setSettingsValue(nextValue);

    appEvents.emit('settingsChanged', nextSettings);
  }, []);

  const setMarketViewState = useCallback((
    marketName: string,
    state: MarketViewState,
  ) => {
    updateSettingsValue((nextSettings) => {
      nextSettings.setMarketViewState(marketName, state);
    });
  }, [updateSettingsValue]);

  const openMarket = useCallback((marketName: string) => {
    updateSettingsValue((nextSettings) => {
      nextSettings.openMarket(marketName, MARKET_VIEW_STATES.quarter);
    });
  }, [updateSettingsValue]);

  const closeMarket = useCallback((marketName: string) => {
    updateSettingsValue((nextSettings) => {
      nextSettings.closeMarket(marketName);
    });
  }, [updateSettingsValue]);

  const moveMarket = useCallback((
    marketName: string,
    targetIndex: number,
  ) => {
    updateSettingsValue((nextSettings) => {
      nextSettings.moveMarket(marketName, targetIndex);
    });
  }, [updateSettingsValue]);

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
    getSettings,
    getMarkets,
    setTheme,
    setLanguage,
    setMarkets,
    setMarketViewState,
    openMarket,
    closeMarket,
    moveMarket,
    applySettingsFromServer,
    updateSettings,
    logger,
  }), [
    markets,
    settings,
    logs,
    getSettings,
    getMarkets,
    setTheme,
    setLanguage,
    setMarkets,
    setMarketViewState,
    openMarket,
    closeMarket,
    moveMarket,
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
