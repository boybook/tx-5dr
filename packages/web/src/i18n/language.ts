export const SUPPORTED_LANGUAGES = ['zh', 'en', 'ja'] as const;

export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export type LanguageMode = AppLanguage | 'system';

export const LANGUAGE_STORAGE_KEY = 'tx5dr-language';
export const LANGUAGE_MODE_CHANGED_EVENT = 'tx5dr-language-mode-changed';

export function resolveSupportedLanguage(language: string | null | undefined): AppLanguage {
  const normalized = language?.toLowerCase() ?? '';
  if (normalized.startsWith('zh')) return 'zh';
  if (normalized.startsWith('ja')) return 'ja';
  return 'en';
}

export function getSystemLanguage(): AppLanguage {
  if (typeof window === 'undefined') {
    return 'en';
  }

  const candidates = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ].filter(Boolean);

  const preferredCjkLanguage = candidates.find((candidate) => {
    const normalized = candidate.toLowerCase();
    return normalized.startsWith('zh') || normalized.startsWith('ja');
  });

  return preferredCjkLanguage ? resolveSupportedLanguage(preferredCjkLanguage) : 'en';
}

export function resolveLanguageMode(value: string | null | undefined): LanguageMode {
  if (value === 'system' || SUPPORTED_LANGUAGES.includes(value as AppLanguage)) {
    return value as LanguageMode;
  }
  return 'system';
}

export function getStoredLanguageMode(): LanguageMode {
  if (typeof window === 'undefined') {
    return 'system';
  }
  return resolveLanguageMode(localStorage.getItem(LANGUAGE_STORAGE_KEY));
}

export function getEffectiveLanguage(mode: LanguageMode): AppLanguage {
  return mode === 'system' ? getSystemLanguage() : mode;
}

export function getInitialLanguage(): AppLanguage {
  return getEffectiveLanguage(getStoredLanguageMode());
}

export function getDocumentLanguage(language: AppLanguage): string {
  switch (language) {
    case 'zh':
      return 'zh-CN';
    case 'ja':
      return 'ja-JP';
    case 'en':
    default:
      return 'en';
  }
}

export function getIntlLocale(language: string | null | undefined): string {
  switch (resolveSupportedLanguage(language)) {
    case 'zh':
      return 'zh-CN';
    case 'ja':
      return 'ja-JP';
    case 'en':
    default:
      return 'en-US';
  }
}
