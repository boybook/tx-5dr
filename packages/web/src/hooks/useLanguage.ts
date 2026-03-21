import { useState, useEffect } from 'react';
import i18n from '../i18n';

export type LanguageMode = 'zh' | 'en' | 'system';

interface UseLanguageReturn {
  language: 'zh' | 'en';
  languageMode: LanguageMode;
  setLanguageMode: (mode: LanguageMode) => void;
}

const LANGUAGE_STORAGE_KEY = 'tx5dr-language';

function getSystemLanguage(): 'zh' | 'en' {
  if (typeof window !== 'undefined' && navigator.language) {
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
  return 'zh';
}

function getStoredLanguageMode(): LanguageMode {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored && ['zh', 'en', 'system'].includes(stored)) {
      return stored as LanguageMode;
    }
  }
  return 'system';
}

export const useLanguage = (): UseLanguageReturn => {
  const [languageMode, setLanguageModeState] = useState<LanguageMode>(getStoredLanguageMode);
  const [systemLanguage, setSystemLanguage] = useState<'zh' | 'en'>(getSystemLanguage);

  const actualLanguage = languageMode === 'system' ? systemLanguage : languageMode;

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

  // 同步语言到 i18n 和 document.documentElement.lang
  useEffect(() => {
    i18n.changeLanguage(actualLanguage);
    document.documentElement.lang = actualLanguage === 'zh' ? 'zh-CN' : 'en';
  }, [actualLanguage]);

  const setLanguageMode = (mode: LanguageMode) => {
    setLanguageModeState(mode);
    if (typeof window !== 'undefined') {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, mode);
    }
  };

  return {
    language: actualLanguage,
    languageMode,
    setLanguageMode,
  };
};
