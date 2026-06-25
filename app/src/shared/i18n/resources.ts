import type { LanguageCode } from './languages.js';

export const i18nResources = {
  ru: {
    translation: {
      app: {
        title: 'WhiteBIT бот',
      },

      settings: {
        title: 'Настройки',
        theme: 'Тема',
        language: 'Язык',
        placeholder: 'Страница настроек будет здесь.',
      },

      routes: {
        dashboard: 'Панель',
        settings: 'Настройки',
      },

      log: {
        title: 'Лог',
        scrollToBottom: 'Прокрутить вниз',

        level: {
          debug: 'Отладка',
          info: 'Инфо',
          warn: 'Предупр.',
          error: 'Ошибка',
        },
        messages: {
          wsConnected: 'WebSocket подключен',
          wsDisconnected: 'WebSocket отключен',
          settingsLoaded: 'Настройки загружены',
          marketsUpdated: 'Список маркетов обновлен',
          wsBinaryReceived: 'Получено бинарное WebSocket-сообщение',
          wsJson: {
            serverHello: 'Получен serverHello',
            pong: 'Получен pong',
            settingsLoaded: 'Получено сообщение settingsLoaded',
            settingsAccepted: 'Настройки приняты сервером',
            marketsUpdated: 'Получено обновление списка маркетов',
          },
        },
      },

      common: {
        save: 'Сохранить',
        close: 'Закрыть',
        loading: 'Загрузка...',
        error: 'Ошибка',
      },

      errors: {
        invalidLanguage: 'Некорректный язык',
        invalidTheme: 'Некорректная тема',
        invalidSettingsPayload: 'Некорректные настройки',
        internalServerError: 'Внутренняя ошибка сервера',
      },
    },
  },

  en: {
    translation: {
      app: {
        title: 'WhiteBIT Bot',
      },

      settings: {
        title: 'Settings',
        theme: 'Theme',
        language: 'Language',
        placeholder: 'Settings page will be here.',
      },

      routes: {
        dashboard: 'Dashboard',
        settings: 'Settings',
      },

      log: {
        title: 'Log',
        scrollToBottom: 'Scroll to bottom',

        level: {
          debug: 'Debug',
          info: 'Info',
          warn: 'Warning',
          error: 'Error',
        },
        messages: {
          wsConnected: 'WebSocket connected',
          wsDisconnected: 'WebSocket disconnected',
          settingsLoaded: 'Settings loaded',
          marketsUpdated: 'Markets updated',
          wsBinaryReceived: 'Binary WebSocket message received',
          wsJson: {
            serverHello: 'Server hello received',
            pong: 'Pong received',
            settingsLoaded: 'Settings loaded message received',
            settingsAccepted: 'Settings accepted',
            marketsUpdated: 'Markets updated message received',
          },
        },
      },

      common: {
        save: 'Save',
        close: 'Close',
        loading: 'Loading...',
        error: 'Error',
      },

      errors: {
        invalidLanguage: 'Invalid language',
        invalidTheme: 'Invalid theme',
        invalidSettingsPayload: 'Invalid settings payload',
        internalServerError: 'Internal server error',
      },
    },
  },
} satisfies Record<LanguageCode, {
  translation: Record<string, unknown>;
}>;
