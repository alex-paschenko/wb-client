// app/src/client/src/components/AppBootstrap.tsx

import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  type AppContextValue,
  useAppContext,
} from '../contexts/AppContext';
import {
  frontendWsController,
} from '../controllers/FrontendWsController';
import {
  synchronizationService,
} from '../services/SynchronizationService';
import {
  appEvents,
} from '../events/app-events';

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

  const [
    issynchronizationCompleted,
    setIssynchronizationCompleted,
  ] = useState(false);

  const [
    startupState,
    setStartupState,
  ] = useState('startup.started');

  const [
    startupError,
    setStartupError,
  ] = useState<unknown>(null);

  useEffect(() => {
    const unsubscribeStartupState =
      appEvents.on(
        'synchronizationStateChanged',
        setStartupState,
      );

    const unsubscribeSynchronizationCompleted =
      appEvents.on(
        'synchronizationCompleted',
        () => {
          setStartupError(null);
          setIssynchronizationCompleted(true);
        },
      );

    const unsubscribeSynchronizationFailed =
      appEvents.on(
        'synchronizationFailed',
        (error) => {
          setStartupError(error);
          setIssynchronizationCompleted(false);
        },
      );

    const unsubscribeConnectionState =
      appEvents.on(
        'frontendWsConnectionStateChanged',
        (isConnected) => {
          if (!isConnected) {
            setIssynchronizationCompleted(false);
            setStartupState(
              'startup.steps.getPrimaryData',
            );

            return;
          }

          setStartupError(null);
          setIssynchronizationCompleted(false);

          void synchronizationService.run().catch(() => {
            // StartupService emits synchronizationFailed.
          });
        },
      );

    frontendWsController.start(
      () => appContextRef.current,
    );

    return () => {
      unsubscribeStartupState();
      unsubscribeSynchronizationCompleted();
      unsubscribeSynchronizationFailed();
      unsubscribeConnectionState();

      frontendWsController.stop();
    };
  }, []);

  if (!issynchronizationCompleted) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg text-fg">
        <div className="text-sm text-muted">
          {startupError
            ? 'startup.failed'
            : startupState}
        </div>
      </div>
    );
  }

  return children;
};
