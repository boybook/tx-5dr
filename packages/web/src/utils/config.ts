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
 * 检测是否在Electron环境中
 */
export function isElectron(): boolean {
  const result = typeof window !== 'undefined' && window.navigator.userAgent.includes('Electron');
  //console.log('🔍 [配置] 环境检测 - Electron环境:', result);
  //console.log('🔍 [配置] User Agent:', typeof window !== 'undefined' ? window.navigator.userAgent : 'N/A');
  return result;
}

/**
 * 获取API基础URL
 * 开发环境：通过Vite代理到localhost:4000
 * 生产环境：使用相对路径/api（同域名）
 * Electron环境：使用localhost:4000
 */
export function getApiBaseUrl(): string {
  const electronEnv = isElectron();
  let result: string;
  
  if (electronEnv) {
    // Electron环境，直接连接到服务器
    result = 'http://localhost:4000/api';
  } else {
    // 统一使用相对路径，由Vite代理或生产环境路由处理
    result = '/api';
  }
  
  console.log('🔍 [配置] API基础URL:', result);
  return result;
}

/**
 * 获取完整的API端点URL
 */
export function getApiUrl(endpoint: string = ''): string {
  const baseUrl = getApiBaseUrl();
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const result = baseUrl + cleanEndpoint;
  console.log('🔍 [配置] API端点URL:', result);
  return result;
}

/**
 * 获取WebSocket URL
 * 开发环境：通过Vite代理
 * 生产环境：使用相对路径
 * Electron环境：使用localhost:4000
 */
export function getWebSocketUrl(): string {
  const electronEnv = isElectron();
  let result: string;
  
  if (electronEnv) {
    // Electron环境，直接连接到服务器
    result = 'ws://localhost:4000/api/ws';
  } else {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    result = `${protocol}//${host}/api/ws`;
  }
  
  console.log('🔍 [配置] WebSocket URL:', result);
  return result;
}

/**
 * 获取当前环境
 */
export function getEnvironment(): 'development' | 'production' {
  return import.meta.env.DEV ? 'development' : 'production';
} 