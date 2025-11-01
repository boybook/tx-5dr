import sharedConfig from '@tx5dr/shared-config/eslint';

export default [
  ...sharedConfig,
  {
    languageOptions: {
      globals: {
        // Node.js 全局变量
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      // 允许未使用的参数(常见于接口实现)
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
];
