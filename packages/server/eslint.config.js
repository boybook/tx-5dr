import sharedConfig from '@tx5dr/shared-config/eslint';

export default [
  ...sharedConfig,
  {
    languageOptions: {
      globals: {
        // Node.js 全局变量
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        NodeJS: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        performance: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        // 浏览器兼容 API
        fetch: 'readonly',
        AbortSignal: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      // 允许未使用的参数
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      // 允许空的 catch 块
      'no-empty': ['error', { allowEmptyCatch: true }],
      // case 中的词法声明降级为警告
      'no-case-declarations': 'warn',
      // prefer-const 降级为警告
      'prefer-const': 'warn',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
];
