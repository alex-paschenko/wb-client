import {
  useEffect,
  useRef,
} from 'react';

import {
  type AppContextValue,
  useAppContext,
} from '../contexts/AppContext';
import { frontendWsService } from '../services/frontend-ws';

export const AppBootstrap = () => {
  const appContext = useAppContext();
  const appContextRef = useRef<AppContextValue>(appContext);

  appContextRef.current = appContext;

  useEffect(() => {
    frontendWsService.start(() => appContextRef.current);

    return () => {
      frontendWsService.stop();
    };
  }, []);

  return null;
};
