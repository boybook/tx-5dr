import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: import.meta.dirname,
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, '..', 'dist', 'contest-logbook-ui'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'contest-log.html'),
      output: { entryFileNames: 'assets/contest-log.js', assetFileNames: 'assets/contest-log.[ext]' },
    },
  },
});
