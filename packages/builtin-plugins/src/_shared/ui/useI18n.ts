/// <reference types="@tx5dr/plugin-api/bridge" />
import { useCallback, useEffect, useState } from 'react';

type Translations = Record<string, Record<string, string>>;

function getBridgeLocale(): string {
  const bridge = typeof window !== 'undefined' ? window.tx5dr : undefined;
  if (bridge?.getState) {
    return bridge.getState().locale || 'en';
  }
  return bridge?.locale || 'en';
}

export function resolveTranslationLocale(
  translations: Translations,
  locale: string,
): string {
  if (translations[locale]) {
    return locale;
  }

  const baseLocale = locale.split('-')[0];
  if (baseLocale && translations[baseLocale]) {
    return baseLocale;
  }

  return translations.en ? 'en' : Object.keys(translations)[0] ?? 'en';
}

export function interpolateText(
  text: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return text;
  return text.replace(/\{([^{}]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  ));
}

export function translateMessage(
  translations: Translations,
  locale: string,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const resolvedLocale = resolveTranslationLocale(translations, locale);
  const dict = translations[resolvedLocale] ?? translations.en ?? {};
  const fallback = resolvedLocale !== 'en' ? translations.en ?? {} : dict;
  return interpolateText(dict[key] ?? fallback[key] ?? key, vars);
}

/**
 * Lightweight i18n hook for plugin iframe pages.
 *
 * Reads the current locale from the Bridge SDK (`window.tx5dr.locale`),
 * falls back to `'en'`, and returns a `t()` function that looks up keys
 * from the provided translation dictionary.
 *
 * The hook also subscribes to Bridge locale changes so pages keep working if
 * the host changes language without reloading the iframe.
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
  const [locale, setLocale] = useState(getBridgeLocale);

  useEffect(() => {
    const bridge = window.tx5dr;
    if (!bridge?.onLocaleChange) return;
    const unsubscribe = bridge.onLocaleChange((nextLocale) => {
      setLocale(nextLocale || 'en');
    });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, []);

  return useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      return translateMessage(translations, locale, key, vars);
    },
    [translations, locale],
  );
}
