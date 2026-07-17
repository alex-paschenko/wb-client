// app/src/client/src/components/AppBootstrap.tsx
import {
  type ReactNode,
  useEffect,
  useRef,
} from 'react';

import {
  type AppContextValue,
  useAppContext,
} from '../contexts/AppContext';
import {
  clientStartDataRequestController,
} from '../controllers/ClientStartDataRequestController';
import {
  frontendWsController,
} from '../controllers/FrontendWsController';
import {
  useController,
} from '../hooks/useController';

interface AppBootstrapProps {
  children: ReactNode;
}

export const AppBootstrap = ({
  children,
}: AppBootstrapProps) => {
  const appContext = useAppContext();

  const appContextRef =
    useRef<AppContextValue>(appContext);

  appContextRef.current = appContext;

  const bootstrapState = useController(
    clientStartDataRequestController,
  );

  useEffect(() => {
    frontendWsController.start(
      () => appContextRef.current,
    );

    return () => {
      frontendWsController.stop();
    };
  }, []);

  if (!bootstrapState.isPrimaryDataReady) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg text-fg">
        <div className="text-sm text-muted">
          Loading…
        </div>
      </div>
    );
  }

  return children;
};
