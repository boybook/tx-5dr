import './App.css';
import { LeftLayout } from './layout/LeftLayout';
import { RightLayout } from './layout/RightLayout';
import { SplitLayout } from './components/SplitLayout';
import { RadioProvider, useRadioState, useProfiles, useConnection } from './store/radioStore';
import { useTheme } from './hooks/useTheme';
import { ProfileSetupOverlay } from './components/ProfileSetupOverlay';
import { ServerDisconnectedOverlay } from './components/ServerDisconnectedOverlay';

function AppContent() {
  const { state } = useRadioState();
  const { pttStatus } = state;
  const { profiles } = useProfiles();
  const { state: connectionState } = useConnection();

  // 首次使用引导：已连接服务器且 Profile 为空时显示
  const showSetupOverlay = connectionState.isConnected && profiles.length === 0;

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
        leftContent={<LeftLayout />}
        rightContent={<RightLayout />}
        defaultLeftWidth={50}
        minLeftWidth={25}
        maxLeftWidth={75}
      />

      {/* 服务器断连蒙层 */}
      <ServerDisconnectedOverlay
        isConnected={connectionState.isConnected}
        isConnecting={connectionState.isConnecting}
        radioService={connectionState.radioService}
      />

      {/* 首次使用引导 */}
      <ProfileSetupOverlay isOpen={showSetupOverlay} />
    </div>
  );
}

function App() {
  // 初始化主题系统
  useTheme();

  return (
    <RadioProvider>
      <AppContent />
    </RadioProvider>
  );
}

export default App; 
