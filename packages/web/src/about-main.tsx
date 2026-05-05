import './i18n/index';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HeroUIProvider } from '@heroui/react';
import { configureApi } from '@tx5dr/core';
import { getApiBaseUrl } from './utils/config';
import { AboutPage } from './pages/AboutPage';
import './index.css';

configureApi(getApiBaseUrl());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <HeroUIProvider>
    <AboutPage />
  </HeroUIProvider>
);
