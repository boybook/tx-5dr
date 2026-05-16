import { useState, useEffect } from 'react';
import i18n from '../i18n/index';
import {
  getDocumentLanguage,
  getEffectiveLanguage,
  getStoredLanguageMode,
  getSystemLanguage,
  LANGUAGE_MODE_CHANGED_EVENT,
  LANGUAGE_STORAGE_KEY,
  type AppLanguage,
  type LanguageMode,
} from '../i18n/language';

export type { AppLanguage, LanguageMode } from '../i18n/language';

interface UseLanguageReturn {
  language: AppLanguage;
  languageMode: LanguageMode;
  setLanguageMode: (mode: LanguageMode) => void;
}

export const useLanguage = (): UseLanguageReturn => {
  const [languageMode, setLanguageModeState] = useState<LanguageMode>(getStoredLanguageMode);
  const [systemLanguage, setSystemLanguage] = useState<AppLanguage>(getSystemLanguage);

  const actualLanguage = languageMode === 'system' ? systemLanguage : getEffectiveLanguage(languageMode);

  // 监听系统语言变化（仅在 system 模式下生效）
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleLanguageChange = () => {
      setSystemLanguage(getSystemLanguage());
    };

    window.addEventListener('languagechange', handleLanguageChange);
    return () => {
      window.removeEventListener('languagechange', handleLanguageChange);
    };
  }, []);

  // 同步同一窗口中的多个 useLanguage 实例，以及其他标签页的语言模式变化。
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const syncStoredMode = () => {
      setLanguageModeState(getStoredLanguageMode());
    };

    window.addEventListener(LANGUAGE_MODE_CHANGED_EVENT, syncStoredMode);
    window.addEventListener('storage', syncStoredMode);
    return () => {
      window.removeEventListener(LANGUAGE_MODE_CHANGED_EVENT, syncStoredMode);
      window.removeEventListener('storage', syncStoredMode);
    };
  }, []);

  // 同步语言到 i18n 和 document.documentElement.lang
  useEffect(() => {
    i18n.changeLanguage(actualLanguage);
    document.documentElement.lang = getDocumentLanguage(actualLanguage);
  }, [actualLanguage]);

  const setLanguageMode = (mode: LanguageMode) => {
    setLanguageModeState(mode);
    if (typeof window !== 'undefined') {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, mode);
      window.dispatchEvent(new Event(LANGUAGE_MODE_CHANGED_EVENT));
    }
  };

  return {
    language: actualLanguage,
    languageMode,
    setLanguageMode,
  };
};
