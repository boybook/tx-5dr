/// <reference types="@tx5dr/plugin-api/bridge" />
import { useCallback, useMemo } from 'react';

type Translations = Record<string, Record<string, string>>;

/**
 * Lightweight i18n hook for plugin iframe pages.
 *
 * Reads the current locale from the Bridge SDK (`window.tx5dr.locale`),
 * falls back to `'en'`, and returns a `t()` function that looks up keys
 * from the provided translation dictionary.
 *
 * @example
 * ```tsx
 * const I18N = {
 *   zh: { title: '设置', save: '保存' },
 *   en: { title: 'Settings', save: 'Save' },
 * };
 *
 * function App() {
 *   const t = useI18n(I18N);
 *   return <h1>{t('title')}</h1>;
 * }
 * ```
 *
 * Variable interpolation is supported with `{key}` placeholders:
 * ```tsx
 * t('greeting', { name: 'World' })
 * // I18N.en.greeting = 'Hello, {name}!'  →  'Hello, World!'
 * ```
 */
export function useI18n(translations: Translations) {
  const locale = useMemo(() => window.tx5dr?.locale || 'en', []);
  const dict = useMemo(
    () => translations[locale] ?? translations.en ?? {},
    [translations, locale],
  );
  const fallback = useMemo(
    () => (locale !== 'en' ? translations.en ?? {} : dict),
    [translations, locale, dict],
  );

  return useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      let text = dict[key] ?? fallback[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          text = text.replace(`{${k}}`, String(v));
        }
      }
      return text;
    },
    [dict, fallback],
  );
}
