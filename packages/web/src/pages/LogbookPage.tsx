import React, { useEffect, useState } from 'react';
import { HeroUIProvider } from '@heroui/react';
import { configureApi, configureAuthToken, api } from '@tx5dr/core';
import { getApiBaseUrl, isElectron } from '../utils/config';
import { useTheme } from '../hooks/useTheme';
import { ThemeToggle } from '../components/common/ThemeToggle';
import LogbookViewer from '../components/logbook/LogbookViewer';
import { useTranslation } from 'react-i18next';
import '../index.css';
import { createLogger } from '../utils/logger';
import { useViewportHeightCssVar } from '../hooks/useViewportHeight';

const logger = createLogger('LogbookPage');
const LOGBOOK_GLOBE_THEME_COLOR = '#020617';
const LOGBOOK_LIGHT_THEME_COLOR = '#f5f5f5';
const LOGBOOK_DARK_THEME_COLOR = '#09090b';

function resolvePageThemeColor(theme: 'light' | 'dark'): string {
  return theme === 'dark' ? LOGBOOK_DARK_THEME_COLOR : LOGBOOK_LIGHT_THEME_COLOR;
}

/**
 * 页面内容组件 - 需要RadioProvider包装
 */
const LogbookContent: React.FC = () => {
  const { t } = useTranslation('logbook');
  const [operatorId, setOperatorId] = useState<string>('');
  const [logBookId, setLogBookId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [operatorCallsign, setOperatorCallsign] = useState<string>('');

  useEffect(() => {
    // 配置API及鉴权
    configureApi(getApiBaseUrl());
    // 独立页面无 AuthProvider，从 localStorage 读取 JWT 并初始化
    const savedJwt = localStorage.getItem('tx5dr_jwt');
    configureAuthToken(savedJwt);

    // 从URL参数获取操作员ID和日志本ID
    const urlParams = new URLSearchParams(window.location.search);
    const opId = urlParams.get('operatorId');
    const logId = urlParams.get('logBookId');

    if (!opId) {
      logger.error('Missing operator ID parameter');
      setLoading(false);
      return;
    }

    setOperatorId(opId);
    setLogBookId(logId || '');

    // 拉取操作员详情以显示呼号（避免依赖主WS与上下文）
    (async () => {
      try {
        if (opId) {
          const detail = await api.getOperator(opId);
          // 使用 myCallsign 而不是 context.myCall
          setOperatorCallsign(detail.data?.myCallsign || opId);
        }
      } catch (e) {
        setOperatorCallsign(opId || '');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="app-viewport-min-height bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-default-300/30 border-t-primary" />
          <p className="text-sm text-default-500">{t('logbookPage.loading')}</p>
        </div>
      </div>
    );
  }

  if (!operatorId) {
    return (
      <div className="app-viewport-min-height bg-background flex items-center justify-center">
        <div className="text-center max-w-md mx-auto p-8">
          {/* 错误图标 */}
          <div className="flex justify-center mb-6">
            <div className="w-20 h-20 bg-danger/10 rounded-full flex items-center justify-center">
              <svg
                className="w-10 h-10 text-danger"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
            </div>
          </div>

          {/* 错误标题 */}
          <h1 className="text-3xl font-bold text-foreground mb-4">
            {t('logbookPage.paramError')}
          </h1>

          {/* 错误描述 */}
          <p className="text-default-600 mb-6 leading-relaxed">
            {t('logbookPage.paramErrorDesc')}
          </p>

          {/* 操作按钮 */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <button
              onClick={() => window.close()}
              className="px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium"
            >
              {t('logbookPage.closeWindow')}
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-3 bg-default-100 text-default-900 rounded-lg hover:bg-default-200 transition-colors font-medium"
            >
              {t('logbookPage.reload')}
            </button>
          </div>

          {/* 帮助提示 */}
          <div className="mt-8 p-4 bg-default-50 rounded-lg border border-default-200">
            <p className="text-sm text-default-600">
              {t('logbookPage.hint')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const inElectron = isElectron();

  return (
    <div className="app-viewport-min-height relative bg-background flex flex-col">
      {inElectron && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-40 h-8"
          style={{
            WebkitAppRegion: 'drag',
          } as React.CSSProperties & { WebkitAppRegion: string }}
        />
      )}

      <div
        className="absolute right-4 top-2 z-50 flex items-center"
        style={inElectron ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string } : {}}
      >
        <ThemeToggle variant="button" size="sm" />
      </div>

      {/* 内容区域 */}
      <div className="flex-1">
        <LogbookViewer
          operatorId={operatorId}
          logBookId={logBookId}
          operatorCallsign={operatorCallsign}
        />
      </div>
    </div>
  );
};

/**
 * 主题感知包装器
 */
const ThemedLogbookWrapper: React.FC = () => {
  // 使用主题钩子来确保主题正确应用
  const { theme } = useTheme();
  useViewportHeightCssVar();

  useEffect(() => {
    document.documentElement.classList.add('logbook-page');
    document.body.classList.add('logbook-page');

    return () => {
      document.documentElement.classList.remove('logbook-page');
      document.body.classList.remove('logbook-page');
    };
  }, []);

  useEffect(() => {
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    const fallbackThemeColor = resolvePageThemeColor(theme);
    const previousThemeColor = themeColorMeta?.getAttribute('content') ?? null;
    let observedBanner: HTMLElement | null = null;
    let intersectionObserver: IntersectionObserver | null = null;
    let frameId = 0;

    const syncThemeColor = () => {
      const globeBanner = document.querySelector<HTMLElement>('[data-logbook-globe-banner="true"]');
      if (!globeBanner) {
        themeColorMeta?.setAttribute('content', fallbackThemeColor);
        document.documentElement.classList.remove('logbook-globe-dominant');
        document.body.classList.remove('logbook-globe-dominant');
        return;
      }

      const rect = globeBanner.getBoundingClientRect();
      const viewportTopThreshold = 72;
      const isGlobeDominant = rect.bottom > viewportTopThreshold;

      themeColorMeta?.setAttribute(
        'content',
        isGlobeDominant ? LOGBOOK_GLOBE_THEME_COLOR : fallbackThemeColor,
      );
      document.documentElement.classList.toggle('logbook-globe-dominant', isGlobeDominant);
      document.body.classList.toggle('logbook-globe-dominant', isGlobeDominant);
    };

    const ensureBannerObserver = () => {
      const globeBanner = document.querySelector<HTMLElement>('[data-logbook-globe-banner="true"]');
      if (globeBanner === observedBanner) {
        return;
      }

      intersectionObserver?.disconnect();
      intersectionObserver = null;
      observedBanner = globeBanner;

      if (!globeBanner) {
        return;
      }

      intersectionObserver = new IntersectionObserver(() => {
        syncThemeColor();
      }, {
        root: null,
        threshold: [0, 0.01, 0.25, 0.5, 0.75, 1],
      });

      intersectionObserver.observe(globeBanner);
    };

    const mutationObserver = new MutationObserver(() => {
      ensureBannerObserver();
      syncThemeColor();
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    ensureBannerObserver();
    syncThemeColor();
    frameId = window.requestAnimationFrame(() => {
      ensureBannerObserver();
      syncThemeColor();
    });
    window.addEventListener('resize', syncThemeColor);

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      mutationObserver.disconnect();
      intersectionObserver?.disconnect();
      window.removeEventListener('resize', syncThemeColor);

      document.documentElement.classList.remove('logbook-globe-dominant');
      document.body.classList.remove('logbook-globe-dominant');

      if (themeColorMeta) {
        if (previousThemeColor == null) {
          themeColorMeta.removeAttribute('content');
        } else {
          themeColorMeta.setAttribute('content', previousThemeColor);
        }
      }
    };
  }, [theme]);

  return (
    <LogbookContent />
  );
};

/**
 * 通联日志独立页面
 * 用于在新窗口或新标签页中显示通联日志
 */
const LogbookPage: React.FC = () => {
  return (
    <HeroUIProvider>
      <ThemedLogbookWrapper />
    </HeroUIProvider>
  );
};

export default LogbookPage;
