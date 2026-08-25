import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  root: import.meta.dirname,
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, '..', '..', '..', 'dist', 'ww-digi', 'ui'),
    emptyOutDir: true,
    rollupOptions: {
      input: { 'contest-log': resolve(import.meta.dirname, 'contest-log.html') },
    },
  },
});
