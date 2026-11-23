import type { UpdateSelection } from '@tx5dr/contracts';
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

interface ShortcutToggles {
  enabled: boolean;
  globalEnabled: boolean;
}

type VoicePttShortcutPreset =
  | 'Backquote'
  | 'Space'
  | 'Home'
  | 'F1'
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F5'
  | 'F6'
  | 'F7'
  | 'F8'
  | 'F9'
  | 'F10'
  | 'F11'
  | 'F12';

interface VoicePttShortcutConfigPayload {
  enabled: boolean;
  preset: VoicePttShortcutPreset;
}

interface VoicePttShortcutCommandPayload {
  type: 'keydown' | 'keyup';
  code: string;
  key: string;
  repeat: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  location: number;
  source: 'electron-before-input';
}

interface DesktopUpdateRecentCommit {
  id: string;
  shortId: string;
  title: string;
  publishedAt: string | null;
}

interface BuildInfo {
  channel: 'release' | 'nightly';
  version: string;
  commit: string;
  commitShort: string;
  tag: string;
  buildTimestamp: string;
}

type DesktopUpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'unsupported' | 'error';

interface DesktopDownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

interface DesktopUpdateStatus extends UpdateSelection {
  channel: 'release' | 'nightly';
  currentVersion: string;
  currentCommit: string | null;
  currentPublishedAt: string | null;
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
    autoUpdateSupported: boolean;
    autoUpdateTarget: string | null;
    installerFamily: string | null;
  }>;
  metadataSource: DesktopUpdateSource | null;
  downloadSource: DesktopUpdateSource | null;
  errorMessage: string | null;
  target: 'electron-app';
  distribution: 'electron';
  identity: string | null;
  websiteUrl: string;
  phase: DesktopUpdatePhase;
  autoUpdateSupported: boolean;
  autoUpdateTarget: string | null;
  autoUpdateInstallerFamily: string | null;
  autoUpdateReason: string | null;
  downloadProgress: DesktopDownloadProgress | null;
  downloaded: boolean;
  pendingInstallIdentity: string | null;
  lastInstallFailed: boolean;
}

type StartupLogSourceId = 'electron-main' | 'server' | 'client-tools';
type StartupErrorKind =
  | 'vc_runtime'
  | 'server_timeout'
  | 'web_timeout'
  | 'port_conflict'
  | 'native_module'
  | 'child_crash'
  | 'child_start_failed'
  | 'unknown';
type StartupErrorActionId = 'open-vc-runtime-download';

interface StartupLogLine {
  id: number;
  source: StartupLogSourceId;
  text: string;
  time: string;
}

interface StartupLogSourceStatus {
  source: StartupLogSourceId;
  label: string;
  path: string;
  exists: boolean;
  size: number;
  error: string | null;
}

interface StartupLogsPayload {
  snapshot: boolean;
  sources: StartupLogSourceStatus[];
  lines: StartupLogLine[];
  startupError: StartupErrorPayload | null;
}

interface StartupErrorPayload {
  kind: StartupErrorKind;
  title: string;
  message: string;
  detail?: string;
  processName?: string;
  actions?: StartupErrorAction[];
}

interface StartupErrorAction {
  id: StartupErrorActionId;
  label: string;
  style: 'primary';
}

const { contextBridge, ipcRenderer, webFrame } = require('electron');

/**
 * Subscribes to a main-process push channel and returns its disposer.
 *
 * Functions passed through contextBridge are re-proxied on every call, so the
 * renderer cannot unsubscribe by passing the same callback again: identity-keyed
 * off*() methods never matched and leaked one listener per re-subscription.
 * The IPC event object is also kept out of the renderer world.
 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/**
 * Electron preload: exposes the desktop bridge to the page through contextBridge.
 *
 * The main process grants each window a capability list (command-line switches
 * built by `electron-main/src/bridgePolicy.ts`) and enforces it again for every
 * IPC call. Namespaces outside the grant are not exposed, so station pages fall
 * back to their browser/server behavior through ordinary feature detection.
 * Local shell pages (`file:`) receive only startup diagnostics and app info.
 */

type BridgeCapability =
  | 'windows' | 'externalLinks' | 'saveFile' | 'selectPath' | 'openAppDirectory'
  | 'appInfo' | 'appLifecycle' | 'closeBehavior' | 'shortcuts' | 'shortcutSettings' | 'desktopUpdates'
  | 'desktopHttps' | 'desktopRemoteAccess' | 'startupLogs' | 'stations' | 'stationManagement';

type StationKind = 'embedded' | 'remote';

function readSwitch(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.find(arg => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

/** Must stay identical to `canonicalPageUrl` in `electron-main/src/bridgePolicy.ts` (checked by a test). */
function canonicalPageUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  // Decode each run of escapes on its own, so a literal `%` elsewhere in the path stays as it is.
  const pathname = url.pathname.replace(/(?:%[0-9a-fA-F]{2})+/g, (escaped) => {
    try {
      return decodeURIComponent(escaped);
    } catch {
      return escaped;
    }
  });
  return `${url.protocol}//${url.host}${pathname}`;
}

/** URLs of the shell's own pages, provided by the main process. */
const shellPageUrls = (readSwitch('tx5dr-shell-pages') ?? '').split(',').filter(Boolean).map(decodeURIComponent);
const isShellPage = (() => {
  const current = globalThis.location;
  if (!current) return false;
  const page = canonicalPageUrl(current.href);
  return page !== null && shellPageUrls.some(candidate => canonicalPageUrl(candidate) === page);
})();
const stationKind: StationKind | null = (() => {
  const value = readSwitch('tx5dr-station-kind');
  return value === 'embedded' || value === 'remote' ? value : null;
})();
const bridgeVersion = Number(readSwitch('tx5dr-bridge-version') ?? '0');
/** Must match the `shell` grant in `electron-main/src/bridgePolicy.ts`. */
const SHELL_PAGE_CAPABILITIES: BridgeCapability[] = ['appInfo', 'startupLogs', 'stations', 'stationManagement'];
const grantedCapabilities: BridgeCapability[] = isShellPage
  ? SHELL_PAGE_CAPABILITIES
  : (readSwitch('tx5dr-bridge-capabilities') ?? '').split(',').filter(Boolean) as BridgeCapability[];
const granted = new Set<BridgeCapability>(grantedCapabilities);
const has = (capability: BridgeCapability): boolean => granted.has(capability);

type FileFilter = { name: string; extensions: string[] };

const electronAPI: Record<string, unknown> = {};

if (!isShellPage && stationKind && bridgeVersion > 0) {
  electronAPI.bridge = Object.freeze({
    version: bridgeVersion,
    kind: stationKind,
    capabilities: Object.freeze([...grantedCapabilities]),
  });
}

if (has('selectPath') || has('saveFile')) {
  electronAPI.fs = {
    ...(has('selectPath') ? {
      selectFile: (options?: { title?: string; filters?: FileFilter[] }): Promise<string | null> =>
        ipcRenderer.invoke('fs:selectFile', options),
      selectDirectory: (options?: { title?: string }): Promise<string | null> =>
        ipcRenderer.invoke('fs:selectDirectory', options),
    } : {}),
    ...(has('saveFile') ? {
      saveFile: (options: {
        title?: string;
        defaultName: string;
        filters?: FileFilter[];
        data: Uint8Array;
      }): Promise<{ canceled: boolean; filePath?: string }> => ipcRenderer.invoke('fs:saveFile', options),
    } : {}),
  };
}

if (has('appInfo') || has('appLifecycle')) {
  electronAPI.app = {
    ...(has('appInfo') ? {
      getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
      /** Build information (channel/commit/tag/buildTimestamp). */
      getBuildInfo: (): Promise<BuildInfo> => ipcRenderer.invoke('app:getBuildInfo'),
    } : {}),
    ...(has('appLifecycle') ? {
      quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
      restart: (): Promise<void> => ipcRenderer.invoke('app:restart'),
    } : {}),
  };
}

if (has('desktopUpdates')) {
  electronAPI.updater = {
    getStatus: (): Promise<DesktopUpdateStatus> => ipcRenderer.invoke('updater:getStatus'),
    check: (): Promise<DesktopUpdateStatus> => ipcRenderer.invoke('updater:check'),
    setChannel: (channel: 'release' | 'nightly'): Promise<DesktopUpdateStatus> => ipcRenderer.invoke('updater:setChannel', { channel }),
    download: (request: { identity: string; allowDowngrade: boolean }): Promise<DesktopUpdateStatus> => ipcRenderer.invoke('updater:download', request),
    installAndRestart: (request: { identity: string; allowDowngrade: boolean }): Promise<DesktopUpdateStatus> => ipcRenderer.invoke('updater:installAndRestart', request),
    openDownload: (url?: string): Promise<void> => ipcRenderer.invoke('updater:openDownload', url),
    onStatus: (callback: (status: DesktopUpdateStatus) => void): (() => void) =>
      subscribe('updater:status', callback),
  };
}

if (has('startupLogs')) {
  electronAPI.startupLogs = {
    openFolder: (): Promise<void> => ipcRenderer.invoke('startupLogs:openFolder'),
    runAction: (actionId: StartupErrorActionId): Promise<void> => ipcRenderer.invoke('startupLogs:runAction', actionId),
    subscribe: async (callback: (payload: StartupLogsPayload) => void): Promise<() => Promise<void>> => {
      const listener = (_event: unknown, payload: StartupLogsPayload) => callback(payload);
      ipcRenderer.on('startupLogs:update', listener);
      try {
        const snapshot = await ipcRenderer.invoke('startupLogs:subscribe') as StartupLogsPayload;
        callback(snapshot);
      } catch (error) {
        ipcRenderer.removeListener('startupLogs:update', listener);
        throw error;
      }

      return async () => {
        ipcRenderer.removeListener('startupLogs:update', listener);
        await ipcRenderer.invoke('startupLogs:unsubscribe');
      };
    },
  };
}

if (!isShellPage) {
  electronAPI.window = {
    ...(has('windows') ? {
      openAbout: (): Promise<void> => ipcRenderer.invoke('window:openAbout'),
      openLogbookWindow: (queryString: string): Promise<void> => ipcRenderer.invoke('window:openLogbook', queryString),
      /** Open a plugin custom UI in the standalone application page host. */
      openPluginPageWindow: (queryString: string): Promise<void> => ipcRenderer.invoke('window:openPluginPage', queryString),
      openSpectrumWindow: (): Promise<void> => ipcRenderer.invoke('window:openSpectrumWindow'),
      /** Subscribe to the spectrum window closing; returns the disposer. */
      onSpectrumWindowClosed: (callback: () => void): (() => void) =>
        subscribe('spectrum-window-closed', () => callback()),
    } : {}),
    /**
     * Current page zoom factor. Native window controls do not scale with page zoom,
     * so the renderer needs it to keep content clear of the macOS traffic lights.
     */
    getZoomFactor: (): number => webFrame.getZoomFactor(),
  };
}

if (has('externalLinks') || has('openAppDirectory')) {
  electronAPI.shell = {
    ...(has('externalLinks') ? {
      /** Open an http(s) link in the system browser. */
      openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
    } : {}),
    ...(has('openAppDirectory') ? {
      /** Open one of the app's own directories in the system file manager. */
      openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:openPath', path),
    } : {}),
  };
}

if (has('closeBehavior')) {
  electronAPI.config = {
    get: (key: string): Promise<unknown> => ipcRenderer.invoke('config:get', key),
    set: (key: string, value: unknown): Promise<void> => ipcRenderer.invoke('config:set', key, value),
    getAll: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('config:getAll'),
  };
}

if (has('shortcuts')) {
  electronAPI.shortcuts = {
    getConfig: (): Promise<ShortcutConfig> => ipcRenderer.invoke('shortcuts:getConfig'),
    getToggles: (): Promise<ShortcutToggles> => ipcRenderer.invoke('shortcuts:getToggles'),
    ...(has('shortcutSettings') ? {
      setConfig: (config: ShortcutConfig): Promise<ShortcutRegistrationStatus> => ipcRenderer.invoke('shortcuts:setConfig', config),
      setToggles: (toggles: ShortcutToggles): Promise<ShortcutRegistrationStatus> => ipcRenderer.invoke('shortcuts:setToggles', toggles),
      register: (config?: ShortcutConfig): Promise<ShortcutRegistrationStatus> => ipcRenderer.invoke('shortcuts:register', config),
      startRecording: (actionId: ShortcutActionId): Promise<void> => ipcRenderer.invoke('shortcuts:startRecording', actionId),
      stopRecording: (): Promise<void> => ipcRenderer.invoke('shortcuts:stopRecording'),
    } : {}),
    onCommand: (callback: (payload: ShortcutCommandPayload) => void): (() => void) =>
      subscribe('shortcut:command', callback),
    onRecorded: (callback: (payload: ShortcutRecordedPayload) => void): (() => void) =>
      subscribe('shortcut:recorded', callback),
    onRecordingCancelled: (callback: (payload: ShortcutRecordingCancelledPayload) => void): (() => void) =>
      subscribe('shortcut:recording-cancelled', callback),
  };
  electronAPI.voicePttShortcut = {
    setConfig: (config: VoicePttShortcutConfigPayload): Promise<void> =>
      ipcRenderer.invoke('voicePttShortcut:setConfig', config),
    onCommand: (callback: (payload: VoicePttShortcutCommandPayload) => void): (() => void) =>
      subscribe('voice-ptt-shortcut:command', callback),
  };
}

if (has('desktopHttps')) {
  electronAPI.https = {
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
  };
}

if (has('desktopRemoteAccess')) {
  electronAPI.remoteAccess = {
    getPreset: (): Promise<'local' | 'lan' | 'public'> => ipcRenderer.invoke('remoteAccess:getPreset'),
    applyPreset: (preset: 'local' | 'lan' | 'public') => ipcRenderer.invoke('remoteAccess:applyPreset', preset),
  };
}

if (has('stations') || has('stationManagement')) {
  electronAPI.stations = {
    openManager: (): Promise<void> => ipcRenderer.invoke('stations:openManager'),
    ...(!isShellPage ? {
      getCurrent: (): Promise<unknown> => ipcRenderer.invoke('stations:getCurrent'),
    } : {}),
    ...(has('stationManagement') ? {
      getState: (): Promise<unknown> => ipcRenderer.invoke('stations:getState'),
      subscribe: async (callback: (state: unknown) => void): Promise<() => Promise<void>> => {
        const listener = (_event: unknown, state: unknown) => callback(state);
        ipcRenderer.on('stations:state', listener);
        try {
          callback(await ipcRenderer.invoke('stations:subscribe'));
        } catch (error) {
          ipcRenderer.removeListener('stations:state', listener);
          throw error;
        }
        return async () => {
          ipcRenderer.removeListener('stations:state', listener);
          await ipcRenderer.invoke('stations:unsubscribe');
        };
      },
      probe: (url: string): Promise<unknown> => ipcRenderer.invoke('stations:probe', url),
      save: (input: unknown): Promise<unknown> => ipcRenderer.invoke('stations:save', input),
      remove: (id: string): Promise<void> => ipcRenderer.invoke('stations:remove', id),
      connect: (id: string): Promise<void> => ipcRenderer.invoke('stations:connect', id),
      trustCertificate: (id: string, fingerprint256: string): Promise<void> =>
        ipcRenderer.invoke('stations:trustCertificate', id, fingerprint256),
    } : {}),
  };
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// The station page's own typing lives in `packages/web/src/types/electron.d.ts`.
export {};
