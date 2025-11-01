import sharedConfig from '@tx5dr/shared-config/eslint';

export default [
  ...sharedConfig,
  {
    languageOptions: {
      globals: {
        // 浏览器环境全局变量
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        CustomEvent: 'readonly',
        Option: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLButtonElement: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        MutationObserver: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        TouchEvent: 'readonly',
        WheelEvent: 'readonly',
        MediaQueryListEvent: 'readonly',
        NodeJS: 'readonly',
        // WebGL 相关
        WebGLRenderingContext: 'readonly',
        WebGL2RenderingContext: 'readonly',
        WebGLProgram: 'readonly',
        WebGLShader: 'readonly',
        WebGLBuffer: 'readonly',
        WebGLTexture: 'readonly',
        // SVG 相关
        SVGSVGElement: 'readonly',
        SVGElement: 'readonly',
        // Base64 编解码
        atob: 'readonly',
        btoa: 'readonly',
      },
    },
    rules: {
      // 允许未使用的参数和变量(常见于 React 开发)
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      // 允许空的 catch 块
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 允许无意义的 try/catch(常见于 async/await)
      'no-useless-catch': 'warn',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'build/**'],
  },
];
