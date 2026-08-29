/// <reference types="@tx5dr/plugin-api/bridge" />
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

createRoot(document.getElementById('root')!).render(<App />);
