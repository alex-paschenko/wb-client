import {
  useEffect,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import { themes, type Theme } from '../../shared/constants/themes';
import { languages, type LanguageCode } from '../../shared/i18n/languages';
import { AppBootstrap } from './components/AppBootstrap';
import { DropdownButton } from './components/DropdownButton';
import { SideMenu } from './components/SideMenu';
import { useAppContext } from './contexts/AppContext';
import { useAppRouter } from './hooks/useAppRouter';

export function App() {
  const { t, i18n } = useTranslation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const {
    settings,
    setTheme,
    setLanguage,
  } = useAppContext();

  const {
    route,
    path,
    navigate,
  } = useAppRouter();

  const theme = settings.getTheme();
  const language = settings.getLanguage();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
  }, [i18n, language]);

  const handleThemeSelect = (nextTheme: Theme) => {
    setTheme(nextTheme);
  };

  const handleLanguageSelect = (nextLanguage: LanguageCode) => {
    setLanguage(nextLanguage);
  };

  const Page = route.Component;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-fg">
      <AppBootstrap />

      <header className="relative flex h-14 w-full shrink-0 items-center border-b border-panel-border bg-panel px-3">
        <button
          className="app-button mr-3"
          type="button"
          onClick={() => setIsMenuOpen(true)}
        >
          ≡
        </button>

        <h1 className="absolute left-1/2 -translate-x-1/2 text-base font-bold sm:text-lg">
          {t('app.title')}
        </h1>

        <div className="ml-auto flex items-center justify-between gap-2">
          <DropdownButton
            label={theme}
            items={themes.map((themeName) => ({
              value: themeName,
              label: themeName,
            }))}
            onSelect={handleThemeSelect}
          />

          <DropdownButton
            label={language}
            items={languages.map((item) => ({
              value: item.code,
              label: item.title,
            }))}
            onSelect={handleLanguageSelect}
          />
        </div>
      </header>

      <SideMenu
        isOpen={isMenuOpen}
        title={t('app.title')}
        currentPath={path}
        onNavigate={navigate}
        onClose={() => setIsMenuOpen(false)}
      />

      <main className="min-h-0 flex-1 overflow-y-auto p-3">
        <Page />
      </main>
    </div>
  );
}
