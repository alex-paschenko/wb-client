export const languages = [
  {
    code: 'ru',
    title: 'Русский',
  },
  {
    code: 'en',
    title: 'English',
  },
] as const;

export type LanguageCode =
  (typeof languages)[number]['code'];

export const defaultLanguage: LanguageCode = 'ru';

export const isLanguageCode = (
  value: unknown,
): value is LanguageCode =>
  typeof value === 'string' &&
  languages.some((language) => language.code === value);
