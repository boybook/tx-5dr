import { useState, useEffect } from 'react';
import { getHello } from '@tx5dr/core';
import type { HelloResponse } from '@tx5dr/contracts';
import { AudioDeviceSettings } from './components/AudioDeviceSettings';
import { DigitalRadioControl } from './components/DigitalRadioControl';
import './App.css';

function App() {
  const [message, setMessage] = useState<string>('Loading...');
  const [error, setError] = useState<string | null>(null);
  const [currentTab, setCurrentTab] = useState<'home' | 'audio' | 'radio'>('radio');

  useEffect(() => {
    async function fetchHello() {
      try {
        const response: HelloResponse = await getHello('http://localhost:4000/api');
        setMessage(response.message);
      } catch (err) {
        setError('Failed to fetch message from server');
        console.error('Error fetching hello:', err);
      }
    }

    fetchHello();
  }, []);

  return (
    <div className="App">
      <header className="App-header">
        <h1>🚀 TX-5DR</h1>
        <p>业余无线电FT8通联与自动电台控制系统</p>
        
        <nav className="nav-tabs">
          <button 
            className={`nav-tab ${currentTab === 'radio' ? 'active' : ''}`}
            onClick={() => setCurrentTab('radio')}
          >
            数字无线电
          </button>
          <button 
            className={`nav-tab ${currentTab === 'home' ? 'active' : ''}`}
            onClick={() => setCurrentTab('home')}
          >
            首页
          </button>
          <button 
            className={`nav-tab ${currentTab === 'audio' ? 'active' : ''}`}
            onClick={() => setCurrentTab('audio')}
          >
            音频设备设置
          </button>
        </nav>
      </header>

      <main className="App-main">
        {currentTab === 'radio' && (
          <DigitalRadioControl />
        )}

        {currentTab === 'home' && (
          <div className="home-content">
            <h2>系统状态</h2>
            {error ? (
              <div className="error">
                <p>错误: {error}</p>
                <p>请确保服务器正在运行在 http://localhost:4000</p>
              </div>
            ) : (
              <div className="success">
                <p>服务器连接正常</p>
                <p>服务器消息: {message}</p>
              </div>
            )}
            
            <div className="features">
              <h3>功能模块</h3>
              <ul>
                <li>✅ 音频设备管理</li>
                <li>✅ 数字无线电引擎控制</li>
                <li>✅ FT8解码显示</li>
                <li>✅ WebSocket实时通信</li>
                <li>🚧 QSO状态机</li>
                <li>🚧 频谱显示</li>
                <li>🚧 自动通联</li>
              </ul>
            </div>
          </div>
        )}

        {currentTab === 'audio' && (
          <AudioDeviceSettings apiBaseUrl="http://localhost:4000/api" />
        )}
      </main>
    </div>
  );
}

export default App; 