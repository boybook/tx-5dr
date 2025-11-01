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
    selectFile: async (_options?: {
      title?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }) => {
      return ipcRenderer.invoke('fs:selectFile', _options);
    },

    /**
     * 选择目录
     */
    selectDirectory: async (_options?: {
      title?: string;
    }) => {
      return ipcRenderer.invoke('fs:selectDirectory', _options);
    },

    /**
     * 读取文件
     */
    readFile: async (_filePath: string) => {
      return ipcRenderer.invoke('fs:readFile', _filePath);
    },

    /**
     * 写入文件
     */
    writeFile: async (_filePath: string, _data: string) => {
      return ipcRenderer.invoke('fs:writeFile', _filePath, _data);
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

  // 窗口管理
  window: {
    /**
     * 打开通联日志窗口
     */
    openLogbookWindow: (_queryString: string) => ipcRenderer.invoke('window:openLogbook', _queryString)
  },

  // 系统集成
  shell: {
    /**
     * 使用系统默认浏览器打开外部链接
     */
    openExternal: (_url: string) => ipcRenderer.invoke('shell:openExternal', _url)
  },

  // 配置管理
  config: {
    /**
     * 获取配置
     */
    get: (_key: string) => ipcRenderer.invoke('config:get', _key),

    /**
     * 设置配置
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set: (_key: string, _value: any) => ipcRenderer.invoke('config:set', _key, _value),

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
      window: {
        openLogbookWindow(queryString: string): Promise<void>;
      };
      shell: {
        openExternal(url: string): Promise<void>;
      };
      config: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        get(key: string): Promise<any>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        set(key: string, value: any): Promise<void>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getAll(): Promise<Record<string, any>>;
      };
    };
  }
} 

// 导出空对象使其成为模块
export {}; 