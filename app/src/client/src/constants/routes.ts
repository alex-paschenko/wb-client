import type {
  ComponentType,
} from 'react';

import { DashboardPage } from '../pages/DashboardPage';
import { SettingsPage } from '../pages/SettingsPage';

export const ROUTE_PATHS = {
  dashboard: '/',
  settings: '/settings',
} as const;

export type RoutePath =
  (typeof ROUTE_PATHS)[keyof typeof ROUTE_PATHS];

export type AppRoute = {
  path: RoutePath;
  titleKey: string;
  Component: ComponentType;
};

export const appRoutes = [
  {
    path: ROUTE_PATHS.dashboard,
    titleKey: 'routes.dashboard',
    Component: DashboardPage,
  },
  {
    path: ROUTE_PATHS.settings,
    titleKey: 'routes.settings',
    Component: SettingsPage,
  },
] satisfies AppRoute[];

export const defaultRoute = appRoutes[0];
