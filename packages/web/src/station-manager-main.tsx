import './i18n/index';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HeroUIProvider } from '@heroui/react';
import { StationManagerPage } from './pages/StationManagerPage';
import './index.css';

// The station manager is a page of the desktop shell itself. It talks only to the
// shell bridge and never to a station API.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <HeroUIProvider>
    <StationManagerPage />
  </HeroUIProvider>
);
