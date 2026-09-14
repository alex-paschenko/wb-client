// app/src/client/src/contexts/AppContext.tsx

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  FrontendSettings,
} from '../../../shared/services/frontend-settings';
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
import type { MarketsByName } from '../../../shared/types/market';
import { globalStateService } from '../../../shared/services/global-state';
import { appEvents } from '../events/app-events';
import type { EntityDesriptor } from '../../../shared/types/storage-entities';

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
  entities: EntityDesriptor[];
  settings: FrontendSettings;
  logs: LogEntry[];

  getSettings: () => FrontendSettings;
  getMarkets: () => MarketsByName;

  setTheme: (theme: string) => void;
  setLanguage: (language: string) => void;

  setMarketViewState: (
    marketName: string,
    state: MarketViewState,
  ) => void;
  openMarket: (marketName: string) => void;
  closeMarket: (marketName: string) => void;
  moveMarket: (marketName: string, targetIndex: number) => void;

  updateSettings: (
    updater: (settings: FrontendSettings) => void,
  ) => void;

  logger: AppLogger;
};

const AppContext =
  createContext<AppContextValue | null>(null);

export const AppProvider = ({
  children,
}: {
  children: ReactNode;
}) => {
  const [
    markets,
    setMarketsState,
  ] = useState<MarketsByName>({});

  const [entities, setEntities] = useState<EntityDesriptor[]>(
    globalStateService.getStorageEntitiesOrNull() ?? [],
  );

  const [
    settingsValue,
    setSettingsValue,
  ] = useState<FrontendSettingsValue>(
    FrontendSettings
      .createDefault()
      .toValue(),
  );

  const [
    logs,
    setLogs,
  ] = useState<LogEntry[]>([]);

  const settingsValueRef =
    useRef<FrontendSettingsValue>(
      settingsValue,
    );

  const settings = useMemo(
    () =>
      FrontendSettings.fromValue(
        settingsValue,
      ),
    [settingsValue],
  );

  useEffect(() => {
    return globalStateService.subscribeMarkets(
      (nextMarkets) => {
        setMarketsState(
          nextMarkets ?? {},
        );
      },
    );
  }, []);

  useEffect(() => {
    return globalStateService.subscribeStorageEntities(
      (nextEntities) => {
        setEntities(nextEntities ?? []);
      },
    );
  }, []);

  useEffect(() => {
    return appEvents.on(
      'synchronizationSettingsProcessed',
      (nextSettings) => {
        const nextValue =
          nextSettings.toValue();

        settingsValueRef.current =
          nextValue;

        setSettingsValue(
          nextValue,
        );
      },
    );
  }, []);

  const getSettings = useCallback(
    (): FrontendSettings => {
      return FrontendSettings.fromValue(
        settingsValueRef.current,
      );
    },
    [],
  );

  const getMarkets = useCallback(
    (): MarketsByName => {
      return globalStateService.getMarkets();
    },
    [],
  );

  const updateSettings =
    useCallback((
      updater: (settings: FrontendSettings) => void,
    ) => {
      const nextSettings =
        FrontendSettings.fromValue(
          settingsValueRef.current,
        );

      updater(
        nextSettings,
      );

      const nextValue =
        nextSettings.toValue();

      settingsValueRef.current =
        nextValue;

      setSettingsValue(
        nextValue,
      );

      appEvents.emit(
        'settingsChanged',
        nextSettings,
      );
    }, []);

  const setTheme = useCallback(
    (theme: string) => {
      updateSettings(
        (nextSettings) => { nextSettings.setTheme(theme); },
      );
    }, [
      updateSettings,
    ]);

  const setLanguage = useCallback(
    (language: string) => {
      updateSettings(
        (nextSettings) => { nextSettings.setLanguage(language); },
      );
    }, [
      updateSettings,
    ]);

  const setMarketViewState =
    useCallback(
      (marketName: string, state: MarketViewState) => {
      updateSettings(
        (nextSettings) => {
          nextSettings.setMarketViewState(marketName, state);
        },
      );
    }, [
      updateSettings,
    ]);

  const openMarket = useCallback(
    (marketName: string) => {
      updateSettings(
        (nextSettings) => {
          nextSettings.openMarket(
            marketName,
            MARKET_VIEW_STATES.quarter,
          );
        },
      );
    }, [
      updateSettings,
    ]);

  const closeMarket = useCallback(
    (marketName: string) => {
      updateSettings(
        (nextSettings) => { nextSettings.closeMarket(marketName); },
      );
    }, [
      updateSettings,
    ]);

  const moveMarket = useCallback(
    (marketName: string, targetIndex: number) => {
      updateSettings(
        (nextSettings) => {
          nextSettings.moveMarket(marketName, targetIndex);
        },
      );
    }, [
      updateSettings,
    ]);

  const addEntry = useCallback(
    (
      level: LogLevel,
      timestamp: number,
      body: string,
    ) => {
      setLogs(
        (currentLogs) => [
          ...currentLogs,
          {
            timestamp,
            level,
            body,
          },
        ],
      );
    },
    [],
  );

  const logger = useMemo<AppLogger>(
    () => ({
      debug: (
        body: string,
      ) => {
        addEntry(
          LOG_LEVELS.debug,
          Date.now(),
          body,
        );
      },

      info: (
        body: string,
      ) => {
        addEntry(
          LOG_LEVELS.info,
          Date.now(),
          body,
        );
      },

      warn: (
        body: string,
      ) => {
        addEntry(
          LOG_LEVELS.warn,
          Date.now(),
          body,
        );
      },

      error: (
        body: string,
      ) => {
        addEntry(
          LOG_LEVELS.error,
          Date.now(),
          body,
        );
      },

      addEntry,
    }),
    [
      addEntry,
    ],
  );

  const value = useMemo<AppContextValue>(
      () => ({
        markets,
        entities,
        settings,
        logs,
        updateSettings,
        getSettings,
        getMarkets,

        setTheme,
        setLanguage,
        setMarketViewState,
        openMarket,
        closeMarket,
        moveMarket,
        logger,
      }),
      [
        markets,
        entities,
        settings,
        logs,
        updateSettings,
        getSettings,
        getMarkets,

        setTheme,
        setLanguage,

        setMarketViewState,
        openMarket,
        closeMarket,
        moveMarket,
        logger,
      ],
    );

  return (
    <AppContext.Provider
      value={value}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext =
  (): AppContextValue => {
    const value =
      useContext(AppContext);

    if (!value) {
      throw new Error(
        'AppContext is not initialized',
      );
    }

    return value;
  };
