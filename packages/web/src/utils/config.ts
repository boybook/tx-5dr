/**
 * 前端配置工具
 * 使用Vite代理服务器，统一使用相对路径
 */

// Vite环境变量类型声明
declare global {
  interface ImportMetaEnv {
    readonly DEV: boolean;
    readonly PROD: boolean;
    readonly MODE: string;
  }
  
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

/**
 * 获取API基础URL
 * 开发环境：通过Vite代理到localhost:4000
 * 生产环境：使用相对路径/api（同域名）
 */
export function getApiBaseUrl(): string {
  // 统一使用相对路径，由Vite代理或生产环境路由处理
  return '';
}

/**
 * 获取完整的API端点URL
 */
export function getApiUrl(endpoint: string = ''): string {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `/api${cleanEndpoint}`;
}

/**
 * 获取WebSocket URL
 * 开发环境：通过Vite代理
 * 生产环境：使用相对路径
 */
export function getWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  return `${protocol}//${host}/api/ws`;
}

/**
 * 获取当前环境
 */
export function getEnvironment(): 'development' | 'production' {
  return import.meta.env.DEV ? 'development' : 'production';
} 