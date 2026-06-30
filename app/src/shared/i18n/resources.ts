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

      time: {
        units: {
          milliseconds_one: '{{count}} миллисекунда',
          milliseconds_few: '{{count}} миллисекунды',
          milliseconds_many: '{{count}} миллисекунд',
          milliseconds_other: '{{count}} миллисекунды',

          seconds_one: '{{count}} секунда',
          seconds_few: '{{count}} секунды',
          seconds_many: '{{count}} секунд',
          seconds_other: '{{count}} секунды',

          minutes_one: '{{count}} минута',
          minutes_few: '{{count}} минуты',
          minutes_many: '{{count}} минут',
          minutes_other: '{{count}} минуты',

          hours_one: '{{count}} час',
          hours_few: '{{count}} часа',
          hours_many: '{{count}} часов',
          hours_other: '{{count}} часа',

          days_one: '{{count}} день',
          days_few: '{{count}} дня',
          days_many: '{{count}} дней',
          days_other: '{{count}} дня',
        },
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

      time: {
        units: {
          milliseconds_one: '{{count}} millisecond',
          milliseconds_other: '{{count}} milliseconds',
          seconds_one: '{{count}} second',
          seconds_other: '{{count}} seconds',
          minutes_one: '{{count}} minute',
          minutes_other: '{{count}} minutes',
          hours_one: '{{count}} hour',
          hours_other: '{{count}} hours',
          days_one: '{{count}} day',
          days_other: '{{count}} days',
        },
      },
    },
  },
} satisfies Record<LanguageCode, {
  translation: Record<string, unknown>;
}>;
