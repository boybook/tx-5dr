import type { DesktopHttpsMode, DesktopHttpsStatus } from '@tx5dr/contracts';

type DesktopUpdateSource = 'oss' | 'github';

interface DesktopUpdateStatus {
  channel: 'release' | 'nightly';
  currentVersion: string;
  currentCommit: string | null;
  checking: boolean;
  updateAvailable: boolean;
  latestVersion: string | null;
  latestCommit: string | null;
  publishedAt: string | null;
  releaseNotes: string | null;
  downloadUrl: string | null;
  downloadOptions: Array<{
    name: string;
    url: string;
    packageType: string;
    platform: string;
    arch: string;
    recommended: boolean;
    source: DesktopUpdateSource;
  }>;
  metadataSource: DesktopUpdateSource | null;
  downloadSource: DesktopUpdateSource | null;
  errorMessage: string | null;
}

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

  updater: {
    getStatus: (): Promise<DesktopUpdateStatus> => ipcRenderer.invoke('updater:getStatus'),
    check: (): Promise<DesktopUpdateStatus> => ipcRenderer.invoke('updater:check'),
    openDownload: (url?: string): Promise<void> => ipcRenderer.invoke('updater:openDownload', url),
  },

  // 窗口管理
  window: {
    /**
     * 打开通联日志窗口
     */
    openLogbookWindow: (_queryString: string) => ipcRenderer.invoke('window:openLogbook', _queryString),

    /**
     * 打开独立频谱图窗口
     */
    openSpectrumWindow: () => ipcRenderer.invoke('window:openSpectrumWindow'),

    /**
     * 监听频谱窗口关闭事件
     */
    onSpectrumWindowClosed: (callback: () => void) => {
      ipcRenderer.on('spectrum-window-closed', callback);
    },

    /**
     * 取消监听频谱窗口关闭事件
     */
    offSpectrumWindowClosed: (callback: () => void) => {
      ipcRenderer.removeListener('spectrum-window-closed', callback);
    }
  },

  // 系统集成
  shell: {
    /**
     * 使用系统默认浏览器打开外部链接
     */
    openExternal: (_url: string) => ipcRenderer.invoke('shell:openExternal', _url),

    /**
     * 在系统文件管理器中打开目录
     */
    openPath: (_path: string) => ipcRenderer.invoke('shell:openPath', _path)
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
  },

  https: {
    getStatus: (): Promise<DesktopHttpsStatus> => ipcRenderer.invoke('https:getStatus'),
    getShareUrls: (): Promise<string[]> => ipcRenderer.invoke('https:getShareUrls'),
    generateSelfSigned: (): Promise<DesktopHttpsStatus> => ipcRenderer.invoke('https:generateSelfSigned'),
    importPemCertificate: (certPath: string, keyPath: string): Promise<DesktopHttpsStatus> =>
      ipcRenderer.invoke('https:importPemCertificate', certPath, keyPath),
    applySettings: (update: {
      enabled?: boolean;
      mode?: DesktopHttpsMode;
      httpsPort?: number;
      redirectExternalHttp?: boolean;
    }): Promise<DesktopHttpsStatus> => ipcRenderer.invoke('https:applySettings', update),
    disable: (): Promise<DesktopHttpsStatus> => ipcRenderer.invoke('https:disable'),
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
      updater: {
        getStatus(): Promise<DesktopUpdateStatus>;
        check(): Promise<DesktopUpdateStatus>;
        openDownload(url?: string): Promise<void>;
      };
      window: {
        openLogbookWindow(queryString: string): Promise<void>;
        openSpectrumWindow(): Promise<void>;
        onSpectrumWindowClosed(callback: () => void): void;
        offSpectrumWindowClosed(callback: () => void): void;
      };
      shell: {
        openExternal(url: string): Promise<void>;
        openPath(path: string): Promise<string>;
      };
      config: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        get(key: string): Promise<any>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        set(key: string, value: any): Promise<void>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getAll(): Promise<Record<string, any>>;
      };
      https: {
        getStatus(): Promise<DesktopHttpsStatus>;
        getShareUrls(): Promise<string[]>;
        generateSelfSigned(): Promise<DesktopHttpsStatus>;
        importPemCertificate(certPath: string, keyPath: string): Promise<DesktopHttpsStatus>;
        applySettings(update: {
          enabled?: boolean;
          mode?: DesktopHttpsMode;
          httpsPort?: number;
          redirectExternalHttp?: boolean;
        }): Promise<DesktopHttpsStatus>;
        disable(): Promise<DesktopHttpsStatus>;
      };
    };
  }
} 

// 导出空对象使其成为模块
export {}; 
