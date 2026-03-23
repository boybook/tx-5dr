import './App.css';
import { LeftLayout } from './layout/LeftLayout';
import { RightLayout } from './layout/RightLayout';
import { VoiceLeftLayout } from './layout/VoiceLeftLayout';
import { VoiceRightLayout } from './layout/VoiceRightLayout';
import { SplitLayout } from './components/SplitLayout';
import { RadioProvider, useRadioState, useProfiles, useConnection } from './store/radioStore';
import { AuthProvider, useAuth, useHasMinRole } from './store/authStore';
import { UserRole } from '@tx5dr/contracts';
import { useTheme } from './hooks/useTheme';
import { ProfileSetupOverlay } from './components/ProfileSetupOverlay';
import { ViewerWelcomeOverlay } from './components/ViewerWelcomeOverlay';
import { ServerDisconnectedOverlay } from './components/ServerDisconnectedOverlay';
import { LoginPage } from './pages/LoginPage';

function AppContent() {
  const { state } = useRadioState();
  const { pttStatus, engineMode } = state;
  const { profiles, profilesLoaded } = useProfiles();
  const { state: connectionState } = useConnection();
  const isAdmin = useHasMinRole(UserRole.ADMIN);

  const noProfiles = connectionState.isConnected && profilesLoaded && profiles.length === 0;
  // 首次使用引导：仅 Admin 可配置电台
  const showSetupOverlay = isAdmin && noProfiles;
  // 观看者欢迎蒙层：非 Admin 用户在无 Profile 时显示
  const showViewerWelcome = !isAdmin && noProfiles;

  const isVoiceMode = engineMode === 'voice';

  return (
    <div className="App h-screen w-full overflow-hidden relative">
      {/* PTT发射状态全局红色内描边 */}
      {pttStatus.isTransmitting && (
        <div
          className="fixed inset-0 pointer-events-none z-[9999]"
          style={{
            border: '6px solid #ef4444',
            borderRadius: '10.5px',
            boxShadow: 'inset 0 0 20px rgba(239, 68, 68, 0.3)'
          }}
        />
      )}

      <SplitLayout
        leftContent={isVoiceMode ? <VoiceLeftLayout /> : <LeftLayout />}
        rightContent={isVoiceMode ? <VoiceRightLayout /> : <RightLayout />}
        defaultLeftWidth={isVoiceMode ? 30 : 50}
        minLeftWidth={25}
        maxLeftWidth={isVoiceMode ? 50 : 75}
      />

      {/* 服务器断连蒙层：仅在曾经连接成功后断线时显示，避免首次加载闪烁 */}
      {connectionState.wasEverConnected && (
        <ServerDisconnectedOverlay
          isConnected={connectionState.isConnected}
          isConnecting={connectionState.isConnecting}
          radioService={connectionState.radioService}
        />
      )}

      {/* 首次使用引导（Admin）/ 观看者欢迎蒙层 */}
      <ProfileSetupOverlay isOpen={showSetupOverlay} />
      <ViewerWelcomeOverlay isOpen={showViewerWelcome} />
    </div>
  );
}

/**
 * 认证门户：根据认证状态决定显示登录页还是主界面
 */
function AuthGate() {
  const { state, requiresLogin } = useAuth();

  // 初始化中 — 显示空白（避免闪烁）
  if (!state.initialized) {
    return null;
  }

  // 需要登录（认证启用 + 不允许公开查看 + 未认证）
  if (requiresLogin) {
    return <LoginPage />;
  }

  // 已认证或公开观察者模式 — 显示主界面
  // key 随身份变化：jwt 变化或 publicViewer 切换时强制重建 RadioProvider（重连 WebSocket）
  const authKey = state.jwt || (state.isPublicViewer ? 'public' : 'anon');

  return (
    <RadioProvider key={authKey}>
      <AppContent />
    </RadioProvider>
  );
}

function App() {
  // 初始化主题系统
  useTheme();

  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

export default App;
