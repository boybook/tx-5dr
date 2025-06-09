const { contextBridge, ipcRenderer } = require('electron');

/**
 * Electron Preload 脚本
 * 通过 contextBridge 安全地暴露 API 给渲染进程
 */

// 设置 API 基础 URL 环境变量
const API_BASE = process.env.EMBEDDED === 'true' 
  ? `http://127.0.0.1:${process.env.SERVER_PORT || 4000}`
  : 'http://localhost:4000';

// 暴露给渲染进程的 API
contextBridge.exposeInMainWorld('electronAPI', {
  // 环境信息
  getApiBase: () => API_BASE,
  isEmbedded: () => process.env.EMBEDDED === 'true',
  
  // 文件系统操作
  fs: {
    /**
     * 选择文件
     */
    selectFile: async (options?: {
      title?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }) => {
      return ipcRenderer.invoke('fs:selectFile', options);
    },
    
    /**
     * 选择目录
     */
    selectDirectory: async (options?: {
      title?: string;
    }) => {
      return ipcRenderer.invoke('fs:selectDirectory', options);
    },
    
    /**
     * 读取文件
     */
    readFile: async (filePath: string) => {
      return ipcRenderer.invoke('fs:readFile', filePath);
    },
    
    /**
     * 写入文件
     */
    writeFile: async (filePath: string, data: string) => {
      return ipcRenderer.invoke('fs:writeFile', filePath, data);
    }
  },
  
  // 应用控制
  app: {
    /**
     * 获取应用版本
     */
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    
    /**
     * 退出应用
     */
    quit: () => ipcRenderer.invoke('app:quit'),
    
    /**
     * 最小化窗口
     */
    minimize: () => ipcRenderer.invoke('app:minimize'),
    
    /**
     * 最大化/还原窗口
     */
    toggleMaximize: () => ipcRenderer.invoke('app:toggleMaximize')
  },
  
  // 配置管理
  config: {
    /**
     * 获取配置
     */
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    
    /**
     * 设置配置
     */
    set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
    
    /**
     * 获取所有配置
     */
    getAll: () => ipcRenderer.invoke('config:getAll')
  }
});

// 类型声明，供 TypeScript 使用
declare global {
  interface Window {
    electronAPI: {
      getApiBase(): string;
      isEmbedded(): boolean;
      fs: {
        selectFile(options?: {
          title?: string;
          filters?: Array<{ name: string; extensions: string[] }>;
        }): Promise<string | null>;
        selectDirectory(options?: { title?: string }): Promise<string | null>;
        readFile(filePath: string): Promise<string>;
        writeFile(filePath: string, data: string): Promise<void>;
      };
      app: {
        getVersion(): Promise<string>;
        quit(): Promise<void>;
        minimize(): Promise<void>;
        toggleMaximize(): Promise<void>;
      };
      config: {
        get(key: string): Promise<any>;
        set(key: string, value: any): Promise<void>;
        getAll(): Promise<Record<string, any>>;
      };
    };
  }
} 

// 导出空对象使其成为模块
export {}; 