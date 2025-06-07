import React from 'react';
import ReactDOM from 'react-dom/client';
import { HeroUIProvider } from '@heroui/react';
import { configureApi } from '@tx5dr/core';
import { getApiBaseUrl } from './utils/config';
import App from './App.tsx';
import './index.css';

// 配置API基础URL
configureApi(getApiBaseUrl());

function ThemedApp() {
  return (
    <HeroUIProvider>
      <App />
    </HeroUIProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ThemedApp />
); 