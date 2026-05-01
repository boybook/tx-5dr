import type { DesktopHttpsMode, DesktopHttpsStatus } from '@tx5dr/contracts';
import type { ShortcutConfig, ShortcutActionId } from '../utils/shortcutPreferences';

type DesktopUpdateSource = 'oss' | 'github';


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
  binding: ShortcutConfig[ShortcutActionId];
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
}

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
    restart(): Promise<void>;
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
  };
  updater?: {
    getStatus(): Promise<DesktopUpdateStatus>;
    check(): Promise<DesktopUpdateStatus>;
    openDownload(url?: string): Promise<void>;
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
  shortcuts?: {
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
