import './App.css';
import { LeftLayout } from './layout/LeftLayout';
import { RightLayout } from './layout/RightLayout';
import { SplitLayout } from './components/SplitLayout';
import { RadioProvider, useRadioState } from './store/radioStore';
import { useTheme } from './hooks/useTheme';

function AppContent() {
  const { state } = useRadioState();
  const { pttStatus } = state;

  return (
    <div className="App h-screen w-full overflow-hidden relative">
      {/* PTT发射状态全局红色内描边 */}
      {pttStatus.isTransmitting && (
        <div
          className="fixed inset-0 pointer-events-none z-[9999]"
          style={{
            border: '6px solid #ef4444',
            borderRadius: '10px',
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
