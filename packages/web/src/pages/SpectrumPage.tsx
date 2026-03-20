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

  useEffect(() => {
    const handler = () => setWindowHeight(window.innerHeight);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return (
    <div className="w-full h-screen overflow-hidden bg-background">
      {showTitlebar && (
        /* 透明拖拽条：fixed 浮于顶部，不占布局空间，左侧 80px no-drag 避免遮挡交通灯 */
        <div
          className="fixed top-0 left-0 right-0 z-50"
          style={{ height: 28, WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <div
            className="h-full"
            style={{ width: 80, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          />
        </div>
      )}
      <SpectrumDisplay height={windowHeight} showPopOut={false} />
    </div>
  );
};

/**
 * 鉴权门户：等待 authStore 初始化后再渲染 RadioProvider
 */
const SpectrumAuthGate: React.FC = () => {
  const { state } = useAuth();

  if (!state.initialized) {
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
