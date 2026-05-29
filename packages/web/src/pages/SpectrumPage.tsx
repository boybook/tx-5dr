import React from 'react';
import { AuthProvider, useAuth } from '../store/authStore';
import { RadioProvider, useConnection } from '../store/radioStore';
import { LoginPage } from './LoginPage';
import { useTheme } from '../hooks/useTheme';
import { useViewportHeightValue } from '../hooks/useViewportHeight';
import { SpectrumDisplay } from '../components/radio/spectrum/SpectrumDisplay';
import { isElectron } from '../utils/config';
import { useLanguage } from '../hooks/useLanguage';

/**
 * 独立频谱图窗口内容，已在 RadioProvider 内部
 * 监听容器尺寸变化，自适应填充整个窗口
 */
const SpectrumContent: React.FC = () => {
  const windowHeight = useViewportHeightValue();
  const { state: connectionState } = useConnection();

  // 仅 macOS Electron 环境需要手动绘制拖拽条
  const showTitlebar = isElectron() && navigator.userAgent.includes('Macintosh');
  const topLeftOverlayInset = showTitlebar
    ? { left: 80 }
    : undefined;

  if (!connectionState.isReady) {
    return (
      <div className="app-viewport-height w-full overflow-hidden bg-background flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-default-300/30 border-t-primary" />
      </div>
    );
  }

  return (
    <div className="app-viewport-height w-full overflow-hidden bg-background">
      {showTitlebar && (
        /* Transparent drag bar: fixed at the top, no layout space.
           outer layer pointer-events:none so mouse events pass through to buttons;
           only the center drag area restores pointer-events:auto + webkit-app-region:drag */
        <div
          className="fixed top-0 left-0 right-0 z-50 flex"
          style={{ height: 28, pointerEvents: 'none' } as React.CSSProperties}
        >
          <div className="h-full" style={{ width: 80 }} />
          <div
            className="flex-1 h-full"
            style={{ pointerEvents: 'auto', WebkitAppRegion: 'drag' } as React.CSSProperties}
          />
          <div className="h-full" style={{ width: 80 }} />
        </div>
      )}
      <SpectrumDisplay
        height={windowHeight}
        showPopOut={false}
        topLeftOverlayInset={topLeftOverlayInset}
      />
    </div>
  );
};

/**
 * 鉴权门户：等待 authStore 初始化，并在需要登录时阻止 RadioProvider 提前建连
 */
const SpectrumAuthGate: React.FC = () => {
  const { state, requiresLogin } = useAuth();

  if (!state.initialized || !state.sessionResolved) {
    return null;
  }

  if (requiresLogin) {
    return <LoginPage />;
  }

  const authKey = state.jwt || (state.isPublicViewer ? 'public' : 'anon');

  return (
    <RadioProvider key={authKey}>
      <SpectrumContent />
    </RadioProvider>
  );
};

/**
 * 频谱图独立窗口根组件
 * 提供主题、鉴权和 WebSocket 连接
 */
export const SpectrumPage: React.FC = () => {
  useTheme();
  useLanguage();

  return (
    <AuthProvider>
      <SpectrumAuthGate />
    </AuthProvider>
  );
};

export default SpectrumPage;
