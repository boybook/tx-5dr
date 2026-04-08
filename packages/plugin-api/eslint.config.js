import sharedConfig from '@tx5dr/shared-config/eslint';

export default [
  ...sharedConfig,
  {
    rules: {
      // This package mostly exports interface/type surfaces, so parameter names are documentation.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-undef': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
];
