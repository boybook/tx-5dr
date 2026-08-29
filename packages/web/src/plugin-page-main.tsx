import './i18n/index';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HeroUIProvider } from '@heroui/react';
import { configureApi } from '@tx5dr/core';
import { getApiBaseUrl } from './utils/config';
import { PluginPage } from './pages/PluginPage';
import './index.css';

configureApi(getApiBaseUrl());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <HeroUIProvider>
    <PluginPage />
  </HeroUIProvider>,
);
