import type { DesktopHttpsMode, DesktopHttpsStatus } from '@tx5dr/contracts';

interface ElectronAPI {
  getApiBase(): string;
  isEmbedded(): boolean;
  fs?: {
    selectFile(options?: {
      title?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<string | null>;
    selectDirectory(options?: { title?: string }): Promise<string | null>;
    readFile(filePath: string): Promise<string>;
    writeFile(filePath: string, data: string): Promise<void>;
  };
  app?: {
    getVersion(): Promise<string>;
    quit(): Promise<void>;
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
  };
  window?: {
    openLogbookWindow(queryString: string): Promise<void>;
    openSpectrumWindow(): Promise<void>;
    onSpectrumWindowClosed(callback: () => void): void;
    offSpectrumWindowClosed(callback: () => void): void;
  };
  shell?: {
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<string>;
  };
  config?: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    getAll(): Promise<Record<string, unknown>>;
  };
  https?: {
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
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
