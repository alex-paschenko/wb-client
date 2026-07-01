import {
  useEffect,
  useRef,
} from 'react';

import {
  type AppContextValue,
  useAppContext,
} from '../contexts/AppContext';
import { frontendWsController } from '../controllers/FrontendWsController';

export const AppBootstrap = () => {
  const appContext = useAppContext();
  const appContextRef = useRef<AppContextValue>(appContext);

  appContextRef.current = appContext;

  useEffect(() => {
    frontendWsController.start(() => appContextRef.current);

    return () => {
      frontendWsController.stop();
    };
  }, []);

  return null;
};
