import './App.css';
import { LeftLayout } from './layout/LeftLayout';
import { RightLayout } from './layout/RightLayout';
import { SplitLayout } from './components/SplitLayout';
import { RadioProvider } from './store/radioStore';
import { useTheme } from './hooks/useTheme';
import { ToastProvider } from '@heroui/toast';

function App() {
  // 初始化主题系统
  useTheme();

  return (
    <RadioProvider>
      <div className="App h-screen w-full overflow-hidden relative">
        <SplitLayout
          leftContent={<LeftLayout />}
          rightContent={<RightLayout />}
          defaultLeftWidth={50}
          minLeftWidth={25}
          maxLeftWidth={75}
        />
        <ToastProvider />
      </div>
    </RadioProvider>
  );
}

export default App; 