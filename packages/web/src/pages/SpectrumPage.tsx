import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from '../store/authStore';
import { RadioProvider } from '../store/radioStore';
import { useTheme } from '../hooks/useTheme';
import { SpectrumDisplay } from '../components/SpectrumDisplay';
import { isElectron } from '../utils/config';


/**
 * 独立频谱图窗口内容，已在 RadioProvider 内部
 * 监听容器尺寸变化，自适应填充整个窗口
 */
const SpectrumContent: React.FC = () => {
  const [windowHeight, setWindowHeight] = useState(window.innerHeight);

  // 仅 macOS Electron 环境需要手动绘制拖拽条
  const showTitlebar = isElectron() && navigator.userAgent.includes('Macintosh');
  const topLeftOverlayInset = showTitlebar
    ? { left: 80 }
    : undefined;

  useEffect(() => {
    const handler = () => setWindowHeight(window.innerHeight);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return (
    <div className="w-full h-screen overflow-hidden bg-background">
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
 * 鉴权门户：等待 authStore 初始化后再渲染 RadioProvider
 */
const SpectrumAuthGate: React.FC = () => {
  const { state } = useAuth();

  if (!state.initialized || !state.sessionResolved) {
    return null;
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

  return (
    <AuthProvider>
      <SpectrumAuthGate />
    </AuthProvider>
  );
};

export default SpectrumPage;
