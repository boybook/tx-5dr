import sharedConfig from '@tx5dr/shared-config/eslint';

export default [
  ...sharedConfig,
  {
    rules: {
      // contracts 包包含大量类型定义和枚举,允许未使用的变量
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
];
