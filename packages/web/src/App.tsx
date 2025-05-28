import { useState, useEffect } from 'react';
import { getHello } from '@tx5dr/core';
import type { HelloResponse } from '@tx5dr/contracts';
import './App.css';
import { LeftLayout } from './layout/LeftLayout';
import { RightLayout } from './layout/RightLayout';
import { SplitLayout } from './components/SplitLayout';
import { RadioProvider } from './store/radioStore';
import { getEnvironment } from './utils/config';

function App() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchHello() {
      try {
        const env = getEnvironment();
        console.log('🌍 当前环境:', env);
        
        const response: HelloResponse = await getHello();
        console.log('Server response:', response.message);
      } catch (err) {
        setError('Failed to fetch message from server');
        console.error('Error fetching hello:', err);
      }
    }

    fetchHello();
  }, []);

  return (
    <RadioProvider>
      <div className="App h-screen w-full overflow-hidden relative">
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}
        <SplitLayout
          leftContent={<LeftLayout />}
          rightContent={<RightLayout />}
          defaultLeftWidth={50}
          minLeftWidth={25}
          maxLeftWidth={75}
        />
      </div>
    </RadioProvider>
  );
}

export default App; 