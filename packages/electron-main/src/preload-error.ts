/**
 * Preload script for error page
 * Exposes IPC communication APIs to the error.html page
 */

import { contextBridge, ipcRenderer } from 'electron';

// 定义暴露给渲染进程的 API 类型
interface ElectronAPI {
  onLogUpdate: (callback: (log: string) => void) => void;
  getStartupLogs: () => Promise<string[]>;
  getErrorType: () => Promise<string>;
}

// 通过 contextBridge 安全地暴露 API
contextBridge.exposeInMainWorld('electronAPI', {
  // 监听日志更新
  onLogUpdate: (callback: (log: string) => void) => {
    ipcRenderer.on('log-update', (_event, log: string) => {
      callback(log);
    });
  },

  // 获取启动日志
  getStartupLogs: (): Promise<string[]> => {
    return ipcRenderer.invoke('get-startup-logs');
  },

  // 获取错误类型
  getErrorType: (): Promise<string> => {
    return ipcRenderer.invoke('get-error-type');
  },
} as ElectronAPI);

// 在全局作用域声明类型（供 error.html 使用）
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
