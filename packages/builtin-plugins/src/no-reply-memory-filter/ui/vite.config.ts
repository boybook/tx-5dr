import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  root: import.meta.dirname,
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, '..', '..', '..', 'dist', 'no-reply-memory-filter', 'ui'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'memory-manager': resolve(import.meta.dirname, 'memory-manager.html'),
      },
    },
  },
});
