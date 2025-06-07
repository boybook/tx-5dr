import { useState, useEffect } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

interface UseThemeReturn {
  theme: 'light' | 'dark';
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
}

const THEME_STORAGE_KEY = 'tx5dr-theme-mode';

export const useTheme = (): UseThemeReturn => {
  // 获取系统偏好
  const getSystemTheme = (): 'light' | 'dark' => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  };

  // 从localStorage读取用户偏好，默认为system
  const getStoredThemeMode = (): ThemeMode => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored && ['light', 'dark', 'system'].includes(stored)) {
        return stored as ThemeMode;
      }
    }
    return 'system';
  };

  const [themeMode, setThemeModeState] = useState<ThemeMode>(getStoredThemeMode);
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(getSystemTheme);

  // 计算实际应用的主题
  const actualTheme = themeMode === 'system' ? systemTheme : themeMode;

  // 监听系统主题变化
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? 'dark' : 'light');
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

  // 应用主题到DOM
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    
    // 移除之前的主题类
    root.classList.remove('light', 'dark');
    body.classList.remove('light', 'dark', 'text-foreground', 'bg-background');
    
    // 添加当前主题类 - 根据HeroUI文档的建议
    root.classList.add(actualTheme);
    body.classList.add(actualTheme, 'text-foreground', 'bg-background');
    
    // 更新CSS变量以适配FT8颜色系统
    if (actualTheme === 'dark') {
      root.style.setProperty('--ft8-cycle-odd', '#D97706'); // 更深的橙色
      root.style.setProperty('--ft8-cycle-even', '#059669'); // 更深的绿色
      root.style.setProperty('--ft8-cycle-odd-bg', 'rgba(217, 119, 6, 0.25)');
      root.style.setProperty('--ft8-cycle-even-bg', 'rgba(5, 150, 105, 0.25)');
    } else {
      // 恢复默认的亮色主题颜色
      root.style.setProperty('--ft8-cycle-odd', '#FFB96A');
      root.style.setProperty('--ft8-cycle-even', '#6CCE64');
      root.style.setProperty('--ft8-cycle-odd-bg', 'rgba(255, 205, 148, 0.2)');
      root.style.setProperty('--ft8-cycle-even-bg', 'rgba(153, 255, 145, 0.2)');
    }
  }, [actualTheme]);

  // 设置主题模式并持久化
  const setThemeMode = (mode: ThemeMode) => {
    setThemeModeState(mode);
    if (typeof window !== 'undefined') {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    }
  };

  // 切换主题（在light和dark之间切换）
  const toggleTheme = () => {
    if (themeMode === 'system') {
      // 如果当前是系统模式，切换到与当前系统主题相反的主题
      setThemeMode(systemTheme === 'dark' ? 'light' : 'dark');
    } else {
      // 如果是手动设置的主题，在light和dark之间切换
      setThemeMode(themeMode === 'dark' ? 'light' : 'dark');
    }
  };

  return {
    theme: actualTheme,
    themeMode,
    setThemeMode,
    toggleTheme,
  };
}; 