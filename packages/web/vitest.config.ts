import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**'],
    // Node 25+ Web Storage globals shadow jsdom's localStorage (see the file).
    setupFiles: ['./src/test/setupStorage.ts'],
  },
}));
