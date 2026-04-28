/**
 * 前端配置工具
 * 使用Vite代理服务器，统一使用相对路径
 */

import { createLogger } from './logger';

const logger = createLogger('Config');

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
  return result;
}

export function isMacOS(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const userAgentDataPlatform = (window.navigator as Navigator & {
    userAgentData?: { platform?: string };
  }).userAgentData?.platform;
  if (typeof userAgentDataPlatform === 'string') {
    return userAgentDataPlatform.toLowerCase() === 'macos';
  }

  const platform = window.navigator.platform?.toLowerCase() || '';
  const userAgent = window.navigator.userAgent.toLowerCase();
  return platform.includes('mac') || userAgent.includes('macintosh') || userAgent.includes('mac os x');
}

/**
 * 获取API基础URL
 * 开发环境：通过Vite代理到localhost:4000
 * 生产环境：使用相对路径/api（同域名）
 * Electron环境：使用localhost:4000
 */
export function getApiBaseUrl(): string {
  // 统一使用相对路径，由 Vite 代理（开发）或 client-tools 反向代理（生产/Electron）处理
  const result = '/api';
  logger.debug('API base URL:', result);
  return result;
}

/**
 * 获取完整的API端点URL
 */
export function getApiUrl(endpoint: string = ''): string {
  const baseUrl = getApiBaseUrl();
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const result = baseUrl + cleanEndpoint;
  logger.debug('API endpoint URL:', result);
  return result;
}

/**
 * 获取WebSocket URL
 * 开发环境：通过Vite代理
 * 生产环境：使用相对路径
 * Electron环境：使用localhost:4000
 */
export function getWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const result = `${protocol}//${host}/api/ws`;
  logger.debug('WebSocket URL:', result);
  return result;
}

/**
 * 获取日志本专用 WebSocket URL（带过滤参数）
 */
export function getLogbookWebSocketUrl(params: { operatorId?: string; logBookId?: string; token?: string }): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const qs = new URLSearchParams();
  if (params.operatorId) qs.set('operatorId', params.operatorId);
  if (params.logBookId) qs.set('logBookId', params.logBookId);
  if (params.token) qs.set('token', params.token);
  const result = `${protocol}//${host}/api/ws/logbook${qs.toString() ? `?${qs.toString()}` : ''}`;
  logger.debug('Logbook WebSocket URL:', result);
  return result;
}

/**
 * Normalize a server-provided WebSocket URL to match the current page protocol.
 * When the page is loaded over HTTPS, upgrade ws:// to wss://.
 * When the page is loaded over HTTP, downgrade wss:// to ws://.
 */
export function normalizeWsUrl(serverUrl: string): string {
  const isPageSecure = window.location.protocol === 'https:';
  try {
    const url = new URL(serverUrl, window.location.href);
    url.protocol = isPageSecure ? 'wss:' : 'ws:';

    // Realtime endpoints are served by the same /api entrypoint as the page.
    // Ignore server-advertised hosts/ports that may be internal reverse-proxy details.
    if (url.pathname.startsWith('/api/realtime/')) {
      url.hostname = window.location.hostname;
      url.port = window.location.port;
    }

    return url.toString();
  } catch {
    if (isPageSecure && serverUrl.startsWith('ws://')) {
      return 'wss://' + serverUrl.slice(5);
    }
    if (!isPageSecure && serverUrl.startsWith('wss://')) {
      return 'ws://' + serverUrl.slice(6);
    }
  }
  return serverUrl;
}

/**
 * 获取当前环境
 */
export function getEnvironment(): 'development' | 'production' {
  return import.meta.env.DEV ? 'development' : 'production';
} 
