import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  appRoutes,
  defaultRoute,
  type AppRoute,
  type RoutePath,
} from '../constants/routes';

const getCurrentPath = (): string => {
  return window.location.pathname || '/';
};

const findRoute = (path: string): AppRoute => {
  return appRoutes.find((route) => route.path === path) ??
    defaultRoute;
};

export const useAppRouter = () => {
  const [path, setPath] = useState(getCurrentPath);

  useEffect(() => {
    const handlePopState = () => {
      setPath(getCurrentPath());
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  const navigate = useCallback((nextPath: RoutePath) => {
    if (nextPath === getCurrentPath()) {
      return;
    }

    window.history.pushState(null, '', nextPath);
    setPath(nextPath);
  }, []);

  const route = useMemo(
    () => findRoute(path),
    [path],
  );

  return {
    route,
    path: route.path,
    navigate,
  };
};
