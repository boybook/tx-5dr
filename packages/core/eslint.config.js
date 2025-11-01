import sharedConfig from '@tx5dr/shared-config/eslint';

export default [
  ...sharedConfig,
  {
    languageOptions: {
      globals: {
        // 浏览器环境全局变量
        console: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        performance: 'readonly',
        URLSearchParams: 'readonly',
        // Node.js 全局变量(同时支持 Node 和浏览器)
        NodeJS: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      // 允许未使用的参数
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      // 允许空的 catch 块(常见于错误处理)
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
];
