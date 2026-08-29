/**
 * 窗口管理工具
 * 处理在Electron和Web环境中打开新窗口的逻辑
 */

import { createLogger } from './logger';

const logger = createLogger('WindowManager');

interface LogbookWindowOptions {
  operatorId: string;
  logBookId?: string;
}

export interface PluginPageWindowOptions {
  pluginName: string;
  pageId: string;
  operatorId?: string;
  params?: Record<string, string>;
}

/**
 * 检查是否在Electron环境中运行
 */
function isElectron(): boolean {
  return typeof window !== 'undefined' && 
         window.navigator && 
         window.navigator.userAgent.toLowerCase().indexOf('electron') > -1;
}

function isAndroid(): boolean {
  return typeof window !== 'undefined'
    && /Android/i.test(window.navigator.userAgent);
}

export function getPluginPageUrl(
  options: PluginPageWindowOptions,
  baseHref: string = document.baseURI,
): string {
  const url = new URL('plugin-page.html', baseHref);
  const params = new URLSearchParams(options.params);
  params.set('pluginName', options.pluginName);
  params.set('pageId', options.pageId);
  if (options.operatorId) {
    params.set('operatorId', options.operatorId);
  } else {
    params.delete('operatorId');
  }
  url.search = params.toString();
  return url.toString();
}

/**
 * Opens a plugin-owned custom UI in the standalone host page.
 *
 * Electron uses an authenticated application window, browsers use a new tab,
 * and Android navigates the existing WebView so the native Back action returns
 * to the radio workspace.
 */
export function openPluginPageWindow(options: PluginPageWindowOptions): void {
  const url = getPluginPageUrl(options);
  const queryString = new URL(url).searchParams.toString();

  if (isElectron() && window.electronAPI?.window?.openPluginPageWindow) {
    void window.electronAPI.window.openPluginPageWindow(queryString);
    return;
  }

  if (isAndroid()) {
    window.location.assign(url);
    return;
  }

  const newWindow = window.open(url, '_blank');
  if (newWindow) {
    newWindow.focus();
    return;
  }

  logger.warn('Plugin page popup was blocked; opening in the current tab');
  window.location.assign(url);
}

/**
 * 打开通联日志窗口
 */
export function openLogbookWindow(options: LogbookWindowOptions): void {
  const { operatorId, logBookId } = options;
  
  // 构建URL参数
  const params = new URLSearchParams({
    operatorId,
    ...(logBookId && { logBookId }),
  });
  
  if (isElectron()) {
    // Electron环境：通过IPC通信请求打开新窗口
    openElectronLogbookWindow(params.toString());
  } else {
    // Web环境：在新标签页中打开
    openWebLogbookWindow(params.toString());
  }
}

/**
 * 在Electron中打开通联日志窗口
 */
function openElectronLogbookWindow(queryString: string): void {
  try {
    // 检查是否有可用的Electron IPC
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof window !== 'undefined' && (window as any).electronAPI?.window?.openLogbookWindow) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electronAPI.window.openLogbookWindow(queryString);
    } else {
      logger.warn('Electron IPC unavailable, falling back to web mode');
      openWebLogbookWindow(queryString);
    }
  } catch (error) {
    logger.error('Failed to open Electron window:', error);
    // 回退到Web模式
    openWebLogbookWindow(queryString);
  }
}

/**
 * 在Web中打开通联日志窗口
 */
function openWebLogbookWindow(queryString: string): void {
  const baseUrl = window.location.origin;
  const logbookUrl = `${baseUrl}/logbook.html?${queryString}`;
  
  // 在新标签页中打开（不指定窗口特性）
  const newWindow = window.open(logbookUrl, '_blank');
  
  if (newWindow) {
    newWindow.focus();
  } else {
    logger.error('Failed to open new tab, may be blocked by browser');
    // 提供后备方案：在同一标签页中打开
    window.location.href = logbookUrl;
  }
}

/**
 * 获取当前操作员的通联日志URL
 */
export function getLogbookUrl(operatorId: string, logBookId?: string): string {
  const params = new URLSearchParams({
    operatorId,
    ...(logBookId && { logBookId }),
  });
  
  const baseUrl = window.location.origin;
  return `${baseUrl}/logbook.html?${params.toString()}`;
}
