import type { DesktopHttpsMode, DesktopHttpsStatus } from '@tx5dr/contracts';

type DesktopUpdateSource = 'oss' | 'github';


type ShortcutActionId =
  | 'toggle-current-operator-tx'
  | 'halt-current-operator-tx'
  | 'select-tx-1'
  | 'select-tx-2'
  | 'select-tx-3'
  | 'select-tx-4'
  | 'select-tx-5'
  | 'select-tx-6'
  | 'start-monitoring'
  | 'stop-monitoring'
  | 'cycle-operator-next'
  | 'cycle-operator-previous'
  | 'reset-current-operator-to-cq'
  | 'force-stop-all-transmission'
  | 'run-tuner-tune'
  | 'toggle-tuner-switch';

interface ShortcutBinding {
  code: string;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  enabled: boolean;
  label: string;
}

type ShortcutConfig = Record<ShortcutActionId, ShortcutBinding>;

interface ShortcutRegistrationStatus {
  config: ShortcutConfig;
  registered: Array<{ actionId: ShortcutActionId; accelerator: string }>;
  failed: Array<{ actionId: ShortcutActionId; accelerator: string; reason: string }>;
}

interface ShortcutCommandPayload {
  actionId: ShortcutActionId;
  accelerator?: string;
  source: 'electron';
}

interface ShortcutRecordedPayload {
  actionId: ShortcutActionId;
  binding: ShortcutBinding;
}

interface ShortcutRecordingCancelledPayload {
  actionId: ShortcutActionId;
}

interface DesktopUpdateRecentCommit {
  id: string;
  shortId: string;
  title: string;
  publishedAt: string | null;
}

interface DesktopUpdateStatus {
  channel: 'release' | 'nightly';
  currentVersion: string;
  currentCommit: string | null;
  checking: boolean;
  updateAvailable: boolean;
  latestVersion: string | null;
  latestCommit: string | null;
  latestCommitTitle: string | null;
  recentCommits: DesktopUpdateRecentCommit[];
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
  target: 'electron-app';
  distribution: 'electron';
  identity: string | null;
  websiteUrl: string;
}

const { contextBridge, ipcRenderer } = require('electron');

const shortcutCommandListeners = new WeakMap<
  (payload: ShortcutCommandPayload) => void,
  (_event: unknown, payload: ShortcutCommandPayload) => void
>();
const shortcutRecordedListeners = new WeakMap<
  (payload: ShortcutRecordedPayload) => void,
  (_event: unknown, payload: ShortcutRecordedPayload) => void
>();
const shortcutRecordingCancelledListeners = new WeakMap<
  (payload: ShortcutRecordingCancelledPayload) => void,
  (_event: unknown, payload: ShortcutRecordingCancelledPayload) => void
>();

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
     * 重启应用
     */
    restart: () => ipcRenderer.invoke('app:restart'),
    
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

  shortcuts: {
    getConfig: (): Promise<ShortcutConfig> => ipcRenderer.invoke('shortcuts:getConfig'),
    setConfig: (config: ShortcutConfig): Promise<ShortcutRegistrationStatus> => ipcRenderer.invoke('shortcuts:setConfig', config),
    register: (config?: ShortcutConfig): Promise<ShortcutRegistrationStatus> => ipcRenderer.invoke('shortcuts:register', config),
    startRecording: (actionId: ShortcutActionId): Promise<void> => ipcRenderer.invoke('shortcuts:startRecording', actionId),
    stopRecording: (): Promise<void> => ipcRenderer.invoke('shortcuts:stopRecording'),
    onCommand: (callback: (payload: ShortcutCommandPayload) => void) => {
      if (shortcutCommandListeners.has(callback)) return;
      const listener = (_event: unknown, payload: ShortcutCommandPayload) => callback(payload);
      shortcutCommandListeners.set(callback, listener);
      ipcRenderer.on('shortcut:command', listener);
    },
    offCommand: (callback: (payload: ShortcutCommandPayload) => void) => {
      const listener = shortcutCommandListeners.get(callback);
      if (!listener) return;
      ipcRenderer.removeListener('shortcut:command', listener);
      shortcutCommandListeners.delete(callback);
    },
    onRecorded: (callback: (payload: ShortcutRecordedPayload) => void) => {
      if (shortcutRecordedListeners.has(callback)) return;
      const listener = (_event: unknown, payload: ShortcutRecordedPayload) => callback(payload);
      shortcutRecordedListeners.set(callback, listener);
      ipcRenderer.on('shortcut:recorded', listener);
    },
    offRecorded: (callback: (payload: ShortcutRecordedPayload) => void) => {
      const listener = shortcutRecordedListeners.get(callback);
      if (!listener) return;
      ipcRenderer.removeListener('shortcut:recorded', listener);
      shortcutRecordedListeners.delete(callback);
    },
    onRecordingCancelled: (callback: (payload: ShortcutRecordingCancelledPayload) => void) => {
      if (shortcutRecordingCancelledListeners.has(callback)) return;
      const listener = (_event: unknown, payload: ShortcutRecordingCancelledPayload) => callback(payload);
      shortcutRecordingCancelledListeners.set(callback, listener);
      ipcRenderer.on('shortcut:recording-cancelled', listener);
    },
    offRecordingCancelled: (callback: (payload: ShortcutRecordingCancelledPayload) => void) => {
      const listener = shortcutRecordingCancelledListeners.get(callback);
      if (!listener) return;
      ipcRenderer.removeListener('shortcut:recording-cancelled', listener);
      shortcutRecordingCancelledListeners.delete(callback);
    },
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
        restart(): Promise<void>;
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
      shortcuts: {
        getConfig(): Promise<ShortcutConfig>;
        setConfig(config: ShortcutConfig): Promise<ShortcutRegistrationStatus>;
        register(config?: ShortcutConfig): Promise<ShortcutRegistrationStatus>;
        startRecording(actionId: ShortcutActionId): Promise<void>;
        stopRecording(): Promise<void>;
        onCommand(callback: (payload: ShortcutCommandPayload) => void): void;
        offCommand(callback: (payload: ShortcutCommandPayload) => void): void;
        onRecorded(callback: (payload: ShortcutRecordedPayload) => void): void;
        offRecorded(callback: (payload: ShortcutRecordedPayload) => void): void;
        onRecordingCancelled(callback: (payload: ShortcutRecordingCancelledPayload) => void): void;
        offRecordingCancelled(callback: (payload: ShortcutRecordingCancelledPayload) => void): void;
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
