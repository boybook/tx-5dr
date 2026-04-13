import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  root: import.meta.dirname,
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, '..', '..', '..', 'dist', 'iframe-panel-demo', 'ui'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'live-monitor': resolve(import.meta.dirname, 'live-monitor.html'),
        'quick-controls': resolve(import.meta.dirname, 'quick-controls.html'),
      },
    },
  },
});
