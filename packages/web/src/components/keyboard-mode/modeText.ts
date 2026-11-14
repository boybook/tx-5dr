import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * i18n scope of a shared keyboard-mode component: keys are `${prefix}.${key}`
 * (e.g. prefix `radio:cw` → `radio:cw.presetMessages`). `defaults` overrides
 * the component's built-in English fallback for individual keys.
 */
export interface KeyboardModeI18n {
  prefix: string;
  defaults?: Partial<Record<string, string>>;
}

export type ModeTextFn = (key: string, options?: Record<string, unknown>) => string;

/** Returns a translator scoped to the mode's key prefix. */
export function useModeText(
  i18n: KeyboardModeI18n,
  builtInDefaults: Partial<Record<string, string>>,
): ModeTextFn {
  const { t } = useTranslation();
  const { prefix, defaults } = i18n;
  return useCallback((key: string, options?: Record<string, unknown>) => {
    const fullKey = `${prefix}.${key}`;
    const defaultValue = defaults?.[key] ?? builtInDefaults[key];
    if (defaultValue === undefined) {
      return options ? t(fullKey, options) : t(fullKey);
    }
    return t(fullKey, { ...options, defaultValue });
  }, [builtInDefaults, defaults, prefix, t]);
}
