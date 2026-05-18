import './i18n/index';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HeroUIProvider } from '@heroui/react';
import { configureApi } from '@tx5dr/core';
import { UserRole } from '@tx5dr/contracts';
import { getApiBaseUrl } from './utils/config';
import { AboutPage } from './pages/AboutPage';
import { AuthProvider, useAuth, useHasMinRole } from './store/authStore';
import './index.css';

configureApi(getApiBaseUrl());

function AboutPageWithAuth() {
  const { state } = useAuth();
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const showUpdateCard = state.initialized && state.sessionResolved && isAdmin;

  return <AboutPage showUpdateCard={showUpdateCard} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <HeroUIProvider>
    <AuthProvider>
      <AboutPageWithAuth />
    </AuthProvider>
  </HeroUIProvider>
);
