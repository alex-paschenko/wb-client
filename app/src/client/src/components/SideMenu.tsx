import { useTranslation } from 'react-i18next';

import type {
  AppRoute,
  RoutePath,
} from '../constants/routes';
import {
  appRoutes,
} from '../constants/routes';

interface SideMenuProps {
  isOpen: boolean;
  title: string;
  currentPath: RoutePath;
  onNavigate: (path: RoutePath) => void;
  onClose: () => void;
}

export function SideMenu({
  isOpen,
  title,
  currentPath,
  onNavigate,
  onClose,
}: SideMenuProps) {
  const { t } = useTranslation();

  const handleNavigate = (route: AppRoute) => {
    onNavigate(route.path);
    onClose();
  };

  return (
    <>
      <aside
        className={[
          'fixed inset-y-0 left-0 z-50 w-72 max-w-[80vw] border-r border-panel-border bg-panel shadow-xl transition-transform duration-200',
          isOpen ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
      >
        <div className="flex h-14 items-center justify-between border-b border-panel-border px-3">
          <span className="font-semibold">{title}</span>

          <button
            className="app-button"
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <nav className="flex flex-col gap-2 p-3">
          {appRoutes.map((route) => {
            const isActive = route.path === currentPath;

            return (
              <button
                key={route.path}
                className={[
                  'app-button text-left',
                  isActive ? 'border-accent text-accent' : '',
                ].join(' ')}
                type="button"
                onClick={() => handleNavigate(route)}
              >
                {t(route.titleKey)}
              </button>
            );
          })}
        </nav>
      </aside>

      {isOpen && (
        <button
          aria-label={t('common.close')}
          className="fixed inset-0 z-40 bg-black/40"
          type="button"
          onClick={onClose}
        />
      )}
    </>
  );
}
