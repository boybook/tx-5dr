import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  root: import.meta.dirname,
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, '..', '..', '..', 'dist', 'clublog-sync', 'ui'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        settings: resolve(import.meta.dirname, 'settings.html'),
        'upload-wizard': resolve(import.meta.dirname, 'upload-wizard.html'),
      },
    },
  },
});
