import { UpdatePreferencesSchema } from '@tx5dr/contracts';
import { z } from 'zod';
import { createUpdateBackup } from './updateBackup.js';
import { app, BrowserWindow, ipcMain, shell, Tray, Menu, dialog, nativeTheme, powerSaveBlocker, session, globalShortcut, type WebContents } from 'electron';
import log from 'electron-log/main';
import { homedir, hostname as getHostname, networkInterfaces } from 'node:os';
import net from 'node:net';
import { join } from 'path';
import http from 'http';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import type { DesktopCurrentStation, DesktopHttpsStatus, DesktopStationsState } from '@tx5dr/contracts';
import { DesktopUpdateService, type DesktopUpdateStatus } from './desktopUpdate.js';
import { BUILD_INFO } from './generated/buildInfo.js';
import { createLogger } from './utils/logger.js';
import { BrowserLoginAuthService } from './browserLoginAuth.js';
import {
  installElectronLogRedaction,
  redactSensitiveText,
} from './sensitiveLog.js';
import { getMessages } from './i18n.js';
import {
  DEFAULT_DESKTOP_HTTPS_CONFIG,
  buildDesktopHttpsStatus,
  disableDesktopHttps,
  ensureDefaultSelfSignedCertificate,
  generateSelfSignedCertificate,
  importPemCertificate,
  sanitizeDesktopHttpsConfig,
  type PersistentDesktopHttpsConfig,
} from './desktopHttps.js';
import { isPrepareShutdownSuccess } from './prepareShutdown.js';
import { awaitServerReadyWithCleanup } from './serverStartupCleanup.js';
import { waitForUrl } from './httpReadiness.js';
import {
  buildChildRuntimeEnv,
  buildNativeModuleCheckExitResult,
  isDegradableNativeModuleCheckFailure,
  type NativeModuleCheckResult,
} from './nativeRuntime.js';
import {
  BackendPortExhaustedError,
  ServerReadyHealthProbeError,
  ServerReadyTimeoutError,
  findAvailableBackendPort,
  getReadyErrorPort,
  isRetryableBackendReadyError,
  probeTx5drServer,
  summarizeProbeResult,
  waitForServerReadyWithProbe,
  type BackendPortDiagnostic,
  type ServerReadyState,
} from './backendPortNegotiation.js';
import {
  VC_REDIST_MIN_VERSION,
  VC_REDIST_X64_URL,
  detectWindowsVCRuntime,
} from './vcRuntime.js';
import { copyRendererFileBytes, sanitizeRendererSaveFileName } from './rendererFileSave.js';
import {
  buildBridgeArguments,
  buildShellPagesArgument,
  evaluateBridgeCall,
  isBridgeConfigKey,
  isValidBridgeConfigValue,
  listBridgeConfigKeys,
  type BridgeStationBinding,
} from './bridgePolicy.js';
import { resolveOpenableAppPath } from './appDirectoryPolicy.js';
import {
  EMBEDDED_STATION_ID,
  allocateGatewayPort,
  createRemoteStationProfile,
  decodeStationSettings,
  findRemoteStation,
  gatewayOrigin,
  normalizeStationUrl,
  removeRemoteStation,
  stationPartition,
  upsertRemoteStation,
  type RemoteStationProfile,
  type StationSettings,
} from './stationProfiles.js';
import { nodeProbeTransport, probeStation, type CertificateSummary, type StationProbeResult } from './stationProbe.js';
import Bonjour from 'bonjour-service';
import {
  STATION_SERVICE_TYPE,
  StationDiscovery,
  type CandidateDescription,
  type StationCandidate,
} from './stationDiscovery.js';
import { RemoteGatewayStartError, RemoteGatewaySupervisor } from './remoteGatewayProcess.js';
import {
  classifyStationNavigation,
  isRemoteStationPermissionAllowed,
  remoteStationWebPreferences,
} from './stationSession.js';

// 获取当前模块的目录(ESM中的__dirname替代方案)
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = dirname(__filename);

installElectronLogRedaction(log);
const logger = createLogger('ElectronMain');
let desktopUpdateService: DesktopUpdateService | null = null;
const DEFAULT_WEB_HTTP_PORT = 8076;
const DEFAULT_WEB_HTTPS_PORT = 8443;
const DEFAULT_PORT_SCAN_STEPS = 50;
const DEFAULT_BACKEND_HTTP_PORT = 4000;
const BACKEND_HEALTH_FAILURE_RETRY_MS = 2_000;
const DEV_FRONTEND_READY_TIMEOUT_MS = 60_000;
const DEV_BACKEND_READY_TIMEOUT_MS = 60_000;
const DEV_PROCESS_MEMORY_LOG_INTERVAL_MS = 30_000;
const FORCE_STARTUP_ERROR_CARD_TEST = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverCheckInterval: any = null;
let serverProcess: import('node:child_process').ChildProcess | null = null;
let webProcess: import('node:child_process').ChildProcess | null = null;
let selectedWebPort: number | null = null;
let selectedServerPort: number | null = null;
let selectedHttpsPort: number | null = null;
let internalShutdownToken: string | null = null;

// 启动错误跟踪
let errorType: string = ''; // 错误类型，空字符串表示无错误
let hasStartupError: boolean = false; // 是否发生启动错误
let crashedProcessName: string = ''; // 崩溃的子进程名
let mainWindowInstance: BrowserWindow | null = null; // 主窗口实例
let trayInstance: Tray | null = null; // 系统托盘实例（Windows/Linux）
let aboutWindow: BrowserWindow | null = null; // “关于”窗口实例（单例）
let isQuitting: boolean = false; // 主动退出标志，防止子进程被杀时弹崩溃错误
const intentionalChildShutdowns = new WeakSet<import('node:child_process').ChildProcess>();
let startupErrorDialogShown = false;
let notificationPermissionHandlersConfigured = false;
let ipcHandlersConfigured = false;
let devProcessMemoryLogInterval: NodeJS.Timeout | null = null;
let mainAppReadyForWindow = false;
let shortcutRecordingWebContentsId: number | null = null;
let shortcutRecordingActionId: ShortcutActionId | null = null;
let startupLogsInterval: NodeJS.Timeout | null = null;
let startupLogsSequence = 0;

const VOICE_PTT_SHORTCUT_PRESETS = [
  'Backquote',
  'Space',
  'Home',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
] as const;

const VOICE_PTT_STALE_KEYDOWN_RECOVERY_MS = 80;

type VoicePttShortcutPreset = typeof VOICE_PTT_SHORTCUT_PRESETS[number];
type VoicePttShortcutCommandType = 'keydown' | 'keyup';

interface VoicePttShortcutConfigPayload {
  enabled?: boolean;
  preset?: unknown;
}

interface VoicePttShortcutCommandPayload {
  type: VoicePttShortcutCommandType;
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

interface VoicePttKeyboardInput {
  type: string;
  code: string;
  key: string;
  isAutoRepeat: boolean;
  alt: boolean;
  control: boolean;
  meta: boolean;
  shift: boolean;
  location: number;
}

interface VoicePttShortcutCaptureState {
  enabled: boolean;
  preset: VoicePttShortcutPreset;
  webContentsId: number | null;
  keyDownActive: boolean;
  lastKeyDownAt: number | null;
}

/**
 * Voice PTT key capture per window. Keyboard input reaches only the focused
 * window, so each station window keeps its own capture and PTT acts on the
 * station the operator is looking at.
 */
const voicePttShortcutCaptures = new Map<number, VoicePttShortcutCaptureState>();

type QuitSource = 'tray-menu' | 'window-close' | 'renderer' | 'before-quit' | 'will-quit' | 'unknown';

interface ChildShutdownOptions {
  softTimeoutMs?: number;
  forceTimeoutMs?: number;
}

interface ChildShutdownResult {
  name: string;
  durationMs: number;
  forced: boolean;
  skipped: boolean;
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
type StartupErrorActionId = 'open-vc-runtime-download' | 'open-station-manager';

interface StartupLogSourceSpec {
  id: StartupLogSourceId;
  label: string;
  fileName: string;
}

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

interface StartupErrorOptions {
  processName?: string;
  detail?: string | null;
  error?: unknown;
  errorType?: string;
  actions?: StartupErrorActionId[];
}

interface FsSelectFileOptions {
  title?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

interface FsSelectDirectoryOptions {
  title?: string;
}

interface FsSaveFileOptions {
  title?: string;
  defaultName?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  data?: Uint8Array;
}

interface CreateMainWindowOptions {
  startHealthCheck?: boolean;
  /** Station the window shows; defaults to the active station. */
  target?: StationWindowTarget;
}

interface StartupLogFileState {
  spec: StartupLogSourceSpec;
  path: string;
  offset: number;
  exists: boolean;
  size: number;
  error: string | null;
}

const CHILD_SHUTDOWN_OPTIONS: Record<'web' | 'server', ChildShutdownOptions> = {
  web: { softTimeoutMs: 1000, forceTimeoutMs: 400 },
  server: { softTimeoutMs: 45_000, forceTimeoutMs: 2_000 },
};
const STARTUP_LOG_SOURCES: StartupLogSourceSpec[] = [
  { id: 'electron-main', label: 'Electron', fileName: 'electron-main.log' },
  { id: 'server', label: 'Server', fileName: 'tx5dr-server.log' },
  { id: 'client-tools', label: 'Web', fileName: 'client-tools.log' },
];
const STARTUP_LOG_INITIAL_LINES = 200;
const STARTUP_LOG_MAX_LINES = 300;
const STARTUP_LOG_POLL_INTERVAL_MS = 100;
const STARTUP_LOG_TAIL_BYTES = 96 * 1024;
const STARTUP_LOG_MAX_READ_BYTES = 256 * 1024;
const startupLogSubscribers = new Map<number, WebContents>();
let startupLogFileStates: StartupLogFileState[] | null = null;
let startupLogLines: StartupLogLine[] = [];
let startupErrorState: StartupErrorPayload | null = null;

// ===== Electron 本地设置 =====
const ELECTRON_SETTINGS_FILE = 'electron-settings.json';

interface ElectronSettings {
  updateChannel?: 'release' | 'nightly';
  closeBehavior: 'ask' | 'tray' | 'quit';
  desktopHttps?: PersistentDesktopHttpsConfig;
  remoteAccessPreset?: 'local' | 'lan' | 'public';
  shortcuts?: ShortcutConfig;
  shortcutToggles?: ShortcutToggles;
  /** Remote station profiles and the active station; decoded by `stationProfiles.ts`. */
  stations?: unknown;
}

const SHORTCUT_ACTION_IDS = [
  'toggle-current-operator-tx',
  'halt-current-operator-tx',
  'select-tx-1',
  'select-tx-2',
  'select-tx-3',
  'select-tx-4',
  'select-tx-5',
  'select-tx-6',
  'start-monitoring',
  'stop-monitoring',
  'cycle-operator-next',
  'cycle-operator-previous',
  'reset-current-operator-to-cq',
  'force-stop-all-transmission',
  'run-tuner-tune',
  'toggle-tuner-switch',
] as const;

type ShortcutActionId = typeof SHORTCUT_ACTION_IDS[number];

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

const DEFAULT_SHORTCUT_TOGGLES: ShortcutToggles = { enabled: true, globalEnabled: true };

function createDefaultShortcutToggles(): ShortcutToggles {
  return { ...DEFAULT_SHORTCUT_TOGGLES };
}

function normalizeShortcutToggles(value: unknown): ShortcutToggles {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createDefaultShortcutToggles();
  }

  const raw = value as Partial<ShortcutToggles>;
  return {
    enabled: raw.enabled !== false,
    globalEnabled: raw.globalEnabled !== false,
  };
}

const DEFAULT_ELECTRON_SETTINGS: ElectronSettings = {
  closeBehavior: 'ask',
  desktopHttps: { ...DEFAULT_DESKTOP_HTTPS_CONFIG, enabled: false },
  remoteAccessPreset: 'local',
  shortcuts: createDefaultShortcutConfig(),
  shortcutToggles: createDefaultShortcutToggles(),
};

function getElectronSettingsPath(): string {
  return path.join(getAppConfigDir(), ELECTRON_SETTINGS_FILE);
}

function safeWriteFileSync(filePath: string, data: string | Buffer, options: { backups?: number; mode?: number } = {}): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const backups = options.backups ?? 3;
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(dir, `${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const fd = fs.openSync(tmpPath, 'w', options.mode ?? 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (fs.existsSync(filePath) && backups > 0) {
    for (let index = backups; index >= 2; index -= 1) {
      const from = `${filePath}.bak.${index - 1}`;
      const to = `${filePath}.bak.${index}`;
      if (fs.existsSync(from)) {
        try { fs.rmSync(to, { force: true }); } catch (error) { logger.debug('failed to remove old settings backup', error); }
        try { fs.renameSync(from, to); } catch (error) { logger.warn('failed to rotate settings backup', error); }
      }
    }
    try { fs.copyFileSync(filePath, `${filePath}.bak.1`); } catch (error) { logger.warn('failed to create settings backup', error); }
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.renameSync(tmpPath, filePath);
      if (process.platform !== 'win32') {
        try {
          const dirFd = fs.openSync(dir, 'r');
          try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
        } catch (error) {
          logger.debug('settings directory fsync skipped', error);
        }
      }
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }

  try { fs.rmSync(tmpPath, { force: true }); } catch (error) { logger.debug('failed to remove settings temp file', error); }
  throw lastError;
}

function readJsonWithBackupsSync<T>(filePath: string, fallback: () => T, normalize: (value: unknown) => T): T {
  const candidates = [filePath, `${filePath}.bak.1`, `${filePath}.bak.2`, `${filePath}.bak.3`];
  const errors: string[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, 'utf-8');
      if (!raw.trim()) throw new Error('empty file');
      const parsed = normalize(JSON.parse(raw));
      if (candidate !== filePath) {
        const corruptPath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        try { fs.renameSync(filePath, corruptPath); } catch (error) { logger.debug('failed to move corrupt settings aside', error); }
        safeWriteFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
      }
      return parsed;
    } catch (error) {
      errors.push(`${candidate}: ${(error as Error).message}`);
    }
  }
  if (fs.existsSync(filePath)) {
    logger.error('failed to load electron settings and no backup could be recovered', { filePath, errors });
  }
  return fallback();
}

function createShortcutBinding(input: Partial<ShortcutBinding> & { code: string }): ShortcutBinding {
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const binding: ShortcutBinding = {
    code,
    key: typeof input.key === 'string' && input.key.trim()
      ? (input.key.length === 1 ? input.key.toUpperCase() : input.key)
      : keyFromShortcutCode(code),
    altKey: Boolean(input.altKey),
    ctrlKey: Boolean(input.ctrlKey),
    metaKey: Boolean(input.metaKey),
    shiftKey: Boolean(input.shiftKey),
    enabled: input.enabled !== false,
    label: '',
  };

  return {
    ...binding,
    label: formatShortcutBinding(binding),
  };
}

function createDisabledShortcutBinding(): ShortcutBinding {
  return {
    code: '',
    key: '',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    enabled: false,
    label: 'Disabled',
  };
}

function createDefaultShortcutConfig(): ShortcutConfig {
  return {
    'toggle-current-operator-tx': createShortcutBinding({ code: 'KeyN', key: 'N', altKey: true }),
    'halt-current-operator-tx': createShortcutBinding({ code: 'KeyH', key: 'H', altKey: true }),
    'select-tx-1': createShortcutBinding({ code: 'Digit1', key: '1', altKey: true }),
    'select-tx-2': createShortcutBinding({ code: 'Digit2', key: '2', altKey: true }),
    'select-tx-3': createShortcutBinding({ code: 'Digit3', key: '3', altKey: true }),
    'select-tx-4': createShortcutBinding({ code: 'Digit4', key: '4', altKey: true }),
    'select-tx-5': createShortcutBinding({ code: 'Digit5', key: '5', altKey: true }),
    'select-tx-6': createShortcutBinding({ code: 'Digit6', key: '6', altKey: true }),
    'start-monitoring': createShortcutBinding({ code: 'KeyM', key: 'M', altKey: true }),
    'stop-monitoring': createShortcutBinding({ code: 'KeyS', key: 'S', altKey: true }),
    'cycle-operator-next': createShortcutBinding({ code: 'KeyO', key: 'O', altKey: true }),
    'cycle-operator-previous': createDisabledShortcutBinding(),
    'reset-current-operator-to-cq': createDisabledShortcutBinding(),
    'force-stop-all-transmission': createDisabledShortcutBinding(),
    'run-tuner-tune': createDisabledShortcutBinding(),
    'toggle-tuner-switch': createDisabledShortcutBinding(),
  };
}

function keyFromShortcutCode(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (code === 'Space') return 'Space';
  if (code === 'Backquote') return '`';
  if (code === 'Minus') return '-';
  if (code === 'Equal') return '=';
  if (code === 'BracketLeft') return '[';
  if (code === 'BracketRight') return ']';
  if (code === 'Backslash') return '\\';
  if (code === 'Semicolon') return ';';
  if (code === 'Quote') return "'";
  if (code === 'Comma') return ',';
  if (code === 'Period') return '.';
  if (code === 'Slash') return '/';
  return code;
}

function formatShortcutBinding(binding: ShortcutBinding): string {
  if (!binding.enabled || !binding.code) return 'Disabled';

  const parts: string[] = [];
  if (binding.ctrlKey) parts.push('Ctrl');
  if (binding.metaKey) parts.push('Meta');
  if (binding.altKey) parts.push('Alt');
  if (binding.shiftKey) parts.push('Shift');
  parts.push(keyFromShortcutCode(binding.code));
  return parts.join('+');
}

function normalizeShortcutBinding(value: unknown, fallback: ShortcutBinding): ShortcutBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createShortcutBinding(fallback);
  }

  const raw = value as Partial<ShortcutBinding>;
  if (raw.enabled === false || raw.code === '') {
    return createDisabledShortcutBinding();
  }

  if (typeof raw.code !== 'string' || raw.code.trim() === '') {
    return createShortcutBinding(fallback);
  }

  return createShortcutBinding(raw as Partial<ShortcutBinding> & { code: string });
}

function normalizeShortcutConfig(value: unknown): ShortcutConfig {
  const defaults = createDefaultShortcutConfig();
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

  return SHORTCUT_ACTION_IDS.reduce((config, actionId) => {
    config[actionId] = normalizeShortcutBinding(source[actionId], defaults[actionId]);
    return config;
  }, {} as ShortcutConfig);
}

function shortcutBindingToAccelerator(binding: ShortcutBinding): string | null {
  if (!binding.enabled || !binding.code) return null;

  const key = acceleratorKeyFromShortcutCode(binding.code);
  if (!key) return null;

  const parts: string[] = [];
  if (binding.ctrlKey) parts.push('Control');
  if (binding.metaKey) parts.push(process.platform === 'darwin' ? 'Command' : 'Super');
  if (binding.altKey) parts.push('Alt');
  if (binding.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

function acceleratorKeyFromShortcutCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (code === 'Space') return 'Space';
  if (code === 'Backquote') return '`';
  if (code === 'Minus') return '-';
  if (code === 'Equal') return '=';
  if (code === 'BracketLeft') return '[';
  if (code === 'BracketRight') return ']';
  if (code === 'Backslash') return '\\';
  if (code === 'Semicolon') return ';';
  if (code === 'Quote') return "'";
  if (code === 'Comma') return ',';
  if (code === 'Period') return '.';
  if (code === 'Slash') return '/';
  return null;
}


function isShortcutActionId(value: unknown): value is ShortcutActionId {
  return typeof value === 'string' && (SHORTCUT_ACTION_IDS as readonly string[]).includes(value);
}

function isModifierOnlyShortcutInput(input: { code?: string; key?: string }): boolean {
  const code = input.code ?? '';
  const key = input.key ?? '';
  return code === 'AltLeft'
    || code === 'AltRight'
    || code === 'ControlLeft'
    || code === 'ControlRight'
    || code === 'MetaLeft'
    || code === 'MetaRight'
    || code === 'ShiftLeft'
    || code === 'ShiftRight'
    || key === 'Alt'
    || key === 'Control'
    || key === 'Meta'
    || key === 'Shift';
}

function createShortcutBindingFromElectronInput(input: {
  code?: string;
  key?: string;
  alt?: boolean;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
}): ShortcutBinding | null {
  if (!input.code || isModifierOnlyShortcutInput(input)) return null;
  if (!input.alt && !input.control && !input.meta && !input.shift) return null;

  return createShortcutBinding({
    code: input.code,
    key: input.key || keyFromShortcutCode(input.code),
    altKey: Boolean(input.alt),
    ctrlKey: Boolean(input.control),
    metaKey: Boolean(input.meta),
    shiftKey: Boolean(input.shift),
  });
}

function normalizeVoicePttShortcutPreset(value: unknown): VoicePttShortcutPreset {
  return typeof value === 'string' && (VOICE_PTT_SHORTCUT_PRESETS as readonly string[]).includes(value)
    ? value as VoicePttShortcutPreset
    : 'Backquote';
}

function updateVoicePttShortcutCapture(
  webContentsId: number,
  payload: VoicePttShortcutConfigPayload,
): VoicePttShortcutCaptureState {
  const preset = normalizeVoicePttShortcutPreset(payload.preset);
  if (payload.enabled !== true) {
    voicePttShortcutCaptures.delete(webContentsId);
    return { enabled: false, preset, webContentsId: null, keyDownActive: false, lastKeyDownAt: null };
  }

  const capture: VoicePttShortcutCaptureState = {
    enabled: true,
    preset,
    webContentsId,
    keyDownActive: false,
    lastKeyDownAt: null,
  };
  voicePttShortcutCaptures.set(webContentsId, capture);
  return { ...capture };
}

function inputHasModifier(input: VoicePttKeyboardInput): boolean {
  return Boolean(input.alt || input.control || input.meta || input.shift);
}

function sendVoicePttShortcutCommand(
  webContents: WebContents,
  input: VoicePttKeyboardInput,
  type: VoicePttShortcutCommandType,
): void {
  webContents.send('voice-ptt-shortcut:command', {
    type,
    code: input.code,
    key: input.key,
    repeat: input.isAutoRepeat,
    altKey: input.alt,
    ctrlKey: input.control,
    metaKey: input.meta,
    shiftKey: input.shift,
    location: input.location,
    source: 'electron-before-input',
  } satisfies VoicePttShortcutCommandPayload);
}

function handleVoicePttShortcutInput(
  event: Electron.Event,
  input: VoicePttKeyboardInput,
  webContents: WebContents,
): boolean {
  const capture = voicePttShortcutCaptures.get(webContents.id);
  if (!capture || !capture.enabled || input.code !== capture.preset) {
    return false;
  }

  if (input.type !== 'keyDown' && input.type !== 'keyUp') {
    return false;
  }

  // Do not start PTT with modifiers, but always allow the matching keyUp to
  // release the debounce guard if the key was pressed before modifiers changed.
  if (inputHasModifier(input) && !(input.type === 'keyUp' && capture.keyDownActive)) {
    return false;
  }

  event.preventDefault();

  if (input.type === 'keyUp') {
    capture.keyDownActive = false;
    capture.lastKeyDownAt = null;
    sendVoicePttShortcutCommand(webContents, input, 'keyup');
    return true;
  }

  if (input.isAutoRepeat) {
    return true;
  }

  const now = Date.now();
  if (capture.keyDownActive) {
    const elapsedMs = capture.lastKeyDownAt === null
      ? Number.POSITIVE_INFINITY
      : now - capture.lastKeyDownAt;

    if (elapsedMs < VOICE_PTT_STALE_KEYDOWN_RECOVERY_MS) {
      return true;
    }

    logger.debug('Voice PTT shortcut keyUp was not observed; recovering debounce on fresh keyDown', {
      preset: capture.preset,
      elapsedMs,
    });
  }

  capture.keyDownActive = true;
  capture.lastKeyDownAt = now;
  sendVoicePttShortcutCommand(webContents, input, 'keydown');
  return true;
}

function stopShortcutRecording(options: { restoreGlobalShortcuts?: boolean } = {}): void {
  shortcutRecordingWebContentsId = null;
  shortcutRecordingActionId = null;

  if (options.restoreGlobalShortcuts) {
    const settings = loadElectronSettings();
    applyShortcutSettings(settings.shortcuts, settings.shortcutToggles);
  }
}

function loadElectronSettings(): ElectronSettings {
  return readJsonWithBackupsSync<ElectronSettings>(
    getElectronSettingsPath(),
    () => ({
      ...DEFAULT_ELECTRON_SETTINGS,
      shortcuts: createDefaultShortcutConfig(),
      shortcutToggles: createDefaultShortcutToggles(),
    }),
    (parsed) => {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('settings root must be an object');
      }
      const settings = parsed as Partial<ElectronSettings>;
      return {
        ...DEFAULT_ELECTRON_SETTINGS,
        ...settings,
        desktopHttps: sanitizeDesktopHttpsConfig(settings.desktopHttps ?? DEFAULT_ELECTRON_SETTINGS.desktopHttps),
        remoteAccessPreset: settings.remoteAccessPreset
          // A recovered legacy object predates this preset and used the old
          // LAN-exposed gateway defaults. Preserve that effective behavior.
          ?? 'lan',
        shortcuts: normalizeShortcutConfig(settings.shortcuts),
        shortcutToggles: normalizeShortcutToggles(settings.shortcutToggles),
      };
    },
  );
}

function saveElectronSettings(settings: ElectronSettings): boolean {
  try {
    const dir = getAppConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    safeWriteFileSync(getElectronSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, { backups: 3, mode: 0o600 });
    return true;
  } catch (err) {
    logger.error('failed to save electron settings', err);
    return false;
  }
}

function getDesktopHttpsConfig(): PersistentDesktopHttpsConfig {
  return sanitizeDesktopHttpsConfig(loadElectronSettings().desktopHttps);
}

const registeredShortcutAccelerators = new Set<string>();

function unregisterGlobalShortcuts(): void {
  for (const accelerator of registeredShortcutAccelerators) {
    globalShortcut.unregister(accelerator);
  }
  registeredShortcutAccelerators.clear();
}

function getShortcutToggles(): ShortcutToggles {
  return loadElectronSettings().shortcutToggles ?? createDefaultShortcutToggles();
}

function applyShortcutSettings(
  configInput: unknown,
  togglesInput: unknown,
): ShortcutRegistrationStatus {
  const config = normalizeShortcutConfig(configInput);
  const toggles = normalizeShortcutToggles(togglesInput);
  const status: ShortcutRegistrationStatus = {
    config,
    registered: [],
    failed: [],
  };

  unregisterGlobalShortcuts();

  if (!toggles.enabled || !toggles.globalEnabled) {
    logger.info('global shortcuts are switched off in shortcut settings', toggles);
    return status;
  }

  for (const actionId of SHORTCUT_ACTION_IDS) {
    const accelerator = shortcutBindingToAccelerator(config[actionId]);
    if (!accelerator) continue;

    try {
      const ok = globalShortcut.register(accelerator, () => {
        // System-wide shortcuts act on the station window the operator used last.
        const targetWindow = getShortcutTargetWindow();
        if (!targetWindow) {
          logger.warn('shortcut command ignored because no station window is available', { actionId, accelerator });
          return;
        }
        targetWindow.webContents.send('shortcut:command', { actionId, accelerator, source: 'electron' });
      });

      if (ok) {
        registeredShortcutAccelerators.add(accelerator);
        status.registered.push({ actionId, accelerator });
      } else {
        status.failed.push({ actionId, accelerator, reason: 'registration_failed' });
      }
    } catch (error) {
      status.failed.push({
        actionId,
        accelerator,
        reason: error instanceof Error ? error.message : 'registration_error',
      });
    }
  }

  if (status.failed.length > 0) {
    logger.warn('some global shortcuts failed to register', status.failed);
  } else {
    logger.info('global shortcuts registered', status.registered);
  }

  return status;
}

function isAllowedNotificationOrigin(rawUrl: string): boolean {
  if (!rawUrl || rawUrl === 'null') {
    return false;
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname;
    const isLoopbackHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    if (!isLoopbackHost) {
      return false;
    }

    if (app.isPackaged) {
      return true;
    }

    return parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function configureNotificationPermissionHandlers(): void {
  if (notificationPermissionHandlersConfigured) {
    return;
  }

  const defaultSession = session.defaultSession;

  defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (permission !== 'notifications') {
      return true;
    }

    return isAllowedNotificationOrigin(requestingOrigin);
  });

  defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission === 'notifications') {
      callback(isAllowedNotificationOrigin(details.requestingUrl));
      return;
    }

    // Auto-grant media (getUserMedia) and other permissions in the desktop app
    callback(true);
  });

  notificationPermissionHandlersConfigured = true;
}

function isDevelopmentRuntime(): boolean {
  return process.env.NODE_ENV === 'development' && !app.isPackaged;
}

function isEnvFlagEnabled(name: string): boolean {
  const value = process.env[name]?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function isEnvFlagDisabled(name: string): boolean {
  const value = process.env[name]?.toLowerCase();
  return value === '0' || value === 'false' || value === 'no' || value === 'off';
}

function shouldOpenDevTools(): boolean {
  return isDevelopmentRuntime() && (
    isEnvFlagEnabled('TX5DR_ELECTRON_OPEN_DEVTOOLS') ||
    isEnvFlagEnabled('ELECTRON_OPEN_DEVTOOLS')
  );
}

function shouldLogDevProcessMemory(): boolean {
  return isDevelopmentRuntime() && !isEnvFlagDisabled('TX5DR_ELECTRON_MEMORY_LOG');
}

function getLanIpv4Addresses(): string[] {
  const interfaces = networkInterfaces();
  const addresses = new Set<string>();

  for (const nets of Object.values(interfaces)) {
    if (!nets) continue;
    for (const item of nets) {
      if (item.family !== 'IPv4' || item.internal || item.address.startsWith('169.254.')) continue;
      addresses.add(item.address);
    }
  }

  return Array.from(addresses);
}

async function getDesktopHttpsStatus(): Promise<DesktopHttpsStatus> {
  return buildDesktopHttpsStatus({
    configDir: getAppConfigDir(),
    config: getDesktopHttpsConfig(),
    hostname: getHostname(),
    httpPort: selectedWebPort || DEFAULT_WEB_HTTP_PORT,
    httpsPort: selectedHttpsPort,
    lanAddresses: getLanIpv4Addresses(),
  });
}

async function ensureDesktopHttpsBeforeGatewayLaunch(context: string): Promise<void> {
  const settings = loadElectronSettings();
  try {
    const result = await ensureDefaultSelfSignedCertificate({
      configDir: getAppConfigDir(),
      hostname: getHostname(),
      lanAddresses: getLanIpv4Addresses(),
      existingConfig: settings.desktopHttps,
    });

    if (!result.changed) {
      logger.info('desktop HTTPS preflight complete', {
        context,
        enabled: result.config.enabled,
        mode: result.config.mode,
        certPath: result.config.certPath,
      });
      return;
    }

    saveElectronSettings({
      ...settings,
      desktopHttps: result.config,
    });
    logger.info('desktop HTTPS self-signed certificate generated', {
      context,
      reason: result.reason,
      certPath: result.config.certPath,
      keyPath: result.config.keyPath,
    });
  } catch (error) {
    logger.error('desktop HTTPS preflight failed; continuing with HTTP gateway fallback', {
      context,
      error,
    });
  }
}

function buildWebChildEnv(serverPort: number): Record<string, string> {
  const httpsConfig = getDesktopHttpsConfig();
  const remoteAccessPreset = loadElectronSettings().remoteAccessPreset ?? 'local';
  const env: Record<string, string> = {
    PORT: String(selectedWebPort || DEFAULT_WEB_HTTP_PORT),
    TARGET: `http://127.0.0.1:${serverPort}`,
    PUBLIC: remoteAccessPreset === 'local' ? '0' : '1',
    HOST: remoteAccessPreset === 'local' ? '127.0.0.1' : '0.0.0.0',
    TX5DR_CLIENT_TOOLS_LOG_FILE: getClientToolsLogPath(),
    TX5DR_CLIENT_TOOLS_READY_FILE: getClientToolsReadyPath(),
    // TX5DR_NETWORK_ACCESS_FILE is an Android bridge input (`addresses`). Pointing the
    // gateway at its own ready file made it read a missing/stale file on every start.
    TX5DR_PORT_SCAN_STEPS: String(DEFAULT_PORT_SCAN_STEPS),
  };

  if (isDevelopmentRuntime()) {
    env.DEV_WEB_TARGET = `http://127.0.0.1:${getDevWebPort()}`;
  } else {
    env.STATIC_DIR = join(resourcesRoot(), 'app', 'packages', 'web', 'dist');
  }


  if (
    httpsConfig.enabled &&
    httpsConfig.certPath &&
    httpsConfig.keyPath &&
    fs.existsSync(httpsConfig.certPath) &&
    fs.existsSync(httpsConfig.keyPath)
  ) {
    env.HTTPS_ENABLE = '1';
    env.HTTPS_PORT = String(httpsConfig.httpsPort || DEFAULT_WEB_HTTPS_PORT);
    env.HTTPS_CERT_FILE = httpsConfig.certPath;
    env.HTTPS_KEY_FILE = httpsConfig.keyPath;
    env.HTTPS_REDIRECT_EXTERNAL_HTTP = httpsConfig.redirectExternalHttp ? '1' : '0';
  }

  return env;
}

function webGatewayEntryPath(): string {
  if (app.isPackaged) {
    return join(resourcesRoot(), 'app', 'packages', 'client-tools', 'src', 'proxy.js');
  }
  return path.resolve(__dirname, '../../client-tools/src/proxy.js');
}

function serverLauncherEntryPath(): string {
  if (app.isPackaged) {
    return join(resourcesRoot(), 'app', 'packages', 'server', 'dist', 'scripts', 'server-launcher.js');
  }
  return path.resolve(__dirname, '../../server/dist/scripts/server-launcher.js');
}

function prepareWebGatewayLaunch(webEntry: string, env: Record<string, string>): void {
  fs.mkdirSync(getAppLogsDir(), { recursive: true });
  try {
    fs.unlinkSync(getClientToolsReadyPath());
  } catch {
    // No stale ready file to remove.
  }
  logger.info('starting web gateway', {
    entry: webEntry,
    requestedPort: env.PORT,
    target: env.TARGET,
    staticDir: env.STATIC_DIR ?? null,
    devWebTarget: env.DEV_WEB_TARGET ?? null,
    httpsEnabled: env.HTTPS_ENABLE === '1',
    requestedHttpsPort: env.HTTPS_PORT ?? null,
    logFile: env.TX5DR_CLIENT_TOOLS_LOG_FILE,
    readyFile: env.TX5DR_CLIENT_TOOLS_READY_FILE,
  });
}

async function waitAndApplyWebGatewayReady(env: Record<string, string>, requestedPort: number): Promise<WebGatewayReadyState> {
  const ready = await waitForWebGatewayReady(env, requestedPort, 60_000, 200, webProcess?.pid ?? undefined);
  selectedWebPort = ready.httpPort || requestedPort;
  selectedHttpsPort = ready.httpsOk ? ready.httpsPort : null;
  logger.info('web gateway ready', {
    requestedPort,
    httpPort: selectedWebPort,
    httpsEnabled: ready.httpsEnabled,
    requestedHttpsPort: ready.requestedHttpsPort,
    httpsPort: selectedHttpsPort,
    staticDir: ready.staticDir ?? null,
    staticDirExists: ready.staticDirExists ?? null,
    target: ready.target ?? null,
    devWebTarget: ready.devWebTarget ?? null,
  });
  return ready;
}

async function restartWebGateway(): Promise<void> {
  if (!selectedServerPort || !selectedWebPort) {
    throw new Error('web_gateway_not_ready');
  }

  const webEntry = webGatewayEntryPath();
  await ensureDesktopHttpsBeforeGatewayLaunch('restart');
  const env = buildWebChildEnv(selectedServerPort);
  prepareWebGatewayLaunch(webEntry, env);

  if (webProcess) {
    await killProcess(webProcess, 'web');
    webProcess = null;
  }

  webProcess = runChild('client-tools', webEntry, env);

  try {
    await waitAndApplyWebGatewayReady(env, selectedWebPort);
  } catch (error) {
    if (webProcess) {
      await killProcess(webProcess, 'web');
      webProcess = null;
    }
    throw error;
  }
}

async function persistDesktopHttpsConfig(
  nextConfig: Partial<PersistentDesktopHttpsConfig>,
): Promise<DesktopHttpsStatus> {
  const settings = loadElectronSettings();
  settings.desktopHttps = sanitizeDesktopHttpsConfig({
    ...settings.desktopHttps,
    ...nextConfig,
  });
  saveElectronSettings(settings);

  if (webProcess && selectedServerPort && selectedWebPort) {
    await restartWebGateway();
  }

  return getDesktopHttpsStatus();
}

async function applyDesktopHttpsSettings(update: Partial<PersistentDesktopHttpsConfig>): Promise<DesktopHttpsStatus> {
  const current = getDesktopHttpsConfig();
  let next = sanitizeDesktopHttpsConfig({
    ...current,
    ...update,
  });

  if (next.enabled && next.mode === 'self-signed') {
    const ensured = await ensureDefaultSelfSignedCertificate({
      configDir: getAppConfigDir(),
      hostname: getHostname(),
      lanAddresses: getLanIpv4Addresses(),
      existingConfig: next,
    });
    next = ensured.config;
    if (ensured.changed) {
      logger.info('desktop HTTPS self-signed certificate generated before applying settings', {
        reason: ensured.reason,
        certPath: next.certPath,
      });
    }
  }

  if (next.enabled) {
    const nextStatus = await buildDesktopHttpsStatus({
      configDir: getAppConfigDir(),
      config: next,
      hostname: getHostname(),
      httpPort: selectedWebPort || DEFAULT_WEB_HTTP_PORT,
      httpsPort: selectedHttpsPort,
      lanAddresses: getLanIpv4Addresses(),
    });
    if (nextStatus.certificateStatus !== 'valid') {
      throw new Error('https_certificate_required');
    }
  }

  return persistDesktopHttpsConfig(next);
}

// ===== Linux GTK 兼容性 =====
// Electron 36 在 GNOME 上默认使用 GTK 4，而 TX-5DR 使用 Electron 的 GTK 3 运行时
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('gtk-version', '3');
}

// ===== macOS 后台节流防护 =====
// 必须在 app.whenReady() 之前调用，阻止 App Nap 降低渲染进程定时器精度
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// ===== 认证 Token 管理 =====
let browserLoginAuthService: BrowserLoginAuthService | null = null;

/**
 * 与 Server AppPaths 保持一致的路径工具
 * 必须使用 'TX-5DR' 而非 app.getPath('userData')，因为后者的 app name
 * 来自 package.json 的 name 字段（'tx-5dr' 小写），在大小写敏感的文件系统上会不一致
 */
const APP_DIR_NAME = 'TX-5DR';

function getAppConfigDir(): string {
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  } else if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), APP_DIR_NAME);
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
    return path.join(xdgConfig, APP_DIR_NAME);
  }
}

function getAppDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  } else if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), APP_DIR_NAME);
  } else {
    return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), APP_DIR_NAME);
  }
}

function getAppLogsDir(): string {
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Logs', APP_DIR_NAME);
  } else if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), APP_DIR_NAME, 'logs');
  } else {
    return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), APP_DIR_NAME, 'logs');
  }
}

function getAppCacheDir(): string {
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Caches', APP_DIR_NAME);
  } else if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), APP_DIR_NAME, 'cache');
  } else {
    return path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), APP_DIR_NAME);
  }
}

function getClientToolsLogPath(): string {
  return path.join(getAppLogsDir(), 'client-tools.log');
}

function getClientToolsReadyPath(): string {
  return path.join(getAppLogsDir(), 'client-tools-ready.json');
}

function getStartupLogPath(fileName: string): string {
  return path.join(getAppLogsDir(), fileName);
}

function sanitizeStartupLogLine(value: string): string {
  return redactSensitiveText(value);
}

function extractStartupLogTime(line: string, fallback: string): string {
  const match = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/);
  return match?.[0] ?? fallback;
}

function appendStartupLogLines(lines: StartupLogLine[]): void {
  if (lines.length === 0) return;
  startupLogLines.push(...lines);
  if (startupLogLines.length > STARTUP_LOG_MAX_LINES) {
    startupLogLines = startupLogLines.slice(-STARTUP_LOG_MAX_LINES);
  }
}

function createStartupLogLine(source: StartupLogSourceId, text: string, fallbackTime = new Date().toISOString()): StartupLogLine {
  const sanitized = sanitizeStartupLogLine(text);
  return {
    id: ++startupLogsSequence,
    source,
    text: sanitized,
    time: extractStartupLogTime(sanitized, fallbackTime),
  };
}

function splitLogLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.length > 0);
}

function readLastLines(filePath: string, maxLines: number): { lines: string[]; size: number; error: string | null } {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return { lines: [], size: 0, error: 'not_a_file' };
    }

    const size = stat.size;
    const start = Math.max(0, size - STARTUP_LOG_TAIL_BYTES);
    const length = size - start;
    if (length <= 0) {
      return { lines: [], size, error: null };
    }

    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      const text = buffer.toString('utf8');
      return { lines: splitLogLines(text).slice(-maxLines), size, error: null };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { lines: [], size: 0, error: null };
    }
    return {
      lines: [],
      size: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function initializeStartupLogTailerState(): void {
  if (startupLogFileStates) return;

  const now = new Date().toISOString();
  startupLogLines = [];
  startupLogFileStates = STARTUP_LOG_SOURCES.map((spec) => {
    const filePath = getStartupLogPath(spec.fileName);
    const result = readLastLines(filePath, STARTUP_LOG_INITIAL_LINES);
    const exists = fs.existsSync(filePath);
    appendStartupLogLines(result.lines.map(line => createStartupLogLine(spec.id, line, now)));
    return {
      spec,
      path: filePath,
      offset: result.size,
      exists,
      size: result.size,
      error: result.error,
    };
  });
  startupLogLines.sort((a, b) => {
    const left = Date.parse(a.time);
    const right = Date.parse(b.time);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) {
      return left - right;
    }
    return a.id - b.id;
  });
  if (startupLogLines.length > STARTUP_LOG_INITIAL_LINES) {
    startupLogLines = startupLogLines.slice(-STARTUP_LOG_INITIAL_LINES);
  }
}

function readStartupLogAppend(state: StartupLogFileState): StartupLogLine[] {
  const now = new Date().toISOString();
  try {
    const stat = fs.statSync(state.path);
    if (!stat.isFile()) {
      state.exists = false;
      state.size = 0;
      state.offset = 0;
      state.error = 'not_a_file';
      return [];
    }

    if (!state.exists) {
      state.exists = true;
    } else if (stat.size < state.offset) {
      state.offset = 0;
    }

    state.error = null;
    state.size = stat.size;
    const lines: StartupLogLine[] = [];
    if (stat.size <= state.offset) {
      return lines;
    }

    let readStart = state.offset;
    if (stat.size - state.offset > STARTUP_LOG_MAX_READ_BYTES) {
      readStart = Math.max(0, stat.size - STARTUP_LOG_MAX_READ_BYTES);
    }

    const length = stat.size - readStart;
    const fd = fs.openSync(state.path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, readStart);
      for (const line of splitLogLines(buffer.toString('utf8'))) {
        lines.push(createStartupLogLine(state.spec.id, line, now));
      }
    } finally {
      fs.closeSync(fd);
    }
    state.offset = stat.size;
    return lines;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      state.exists = false;
      state.size = 0;
      state.offset = 0;
      state.error = null;
      return [];
    }

    const message = error instanceof Error ? error.message : String(error);
    state.error = message;
    return [];
  }
}

function createStartupLogsPayload(snapshot: boolean, lines?: StartupLogLine[]): StartupLogsPayload {
  initializeStartupLogTailerState();
  return {
    snapshot,
    sources: (startupLogFileStates ?? []).map(state => ({
      source: state.spec.id,
      label: state.spec.label,
      path: state.path,
      exists: state.exists,
      size: state.size,
      error: state.error,
    })),
    lines: lines ?? startupLogLines,
    startupError: startupErrorState,
  };
}

function broadcastStartupLogPayload(payload: StartupLogsPayload): void {
  for (const [id, contents] of startupLogSubscribers) {
    if (contents.isDestroyed()) {
      startupLogSubscribers.delete(id);
      continue;
    }
    contents.send('startupLogs:update', payload);
  }
}

function pollStartupLogs(): void {
  if (!startupLogFileStates) return;
  const newLines = startupLogFileStates.flatMap(state => readStartupLogAppend(state));
  if (newLines.length === 0) return;
  appendStartupLogLines(newLines);
  broadcastStartupLogPayload(createStartupLogsPayload(false, newLines));
}

function ensureStartupLogsPolling(): void {
  initializeStartupLogTailerState();
  if (startupLogsInterval) return;
  startupLogsInterval = setInterval(pollStartupLogs, STARTUP_LOG_POLL_INTERVAL_MS);
}

function removeStartupLogSubscriber(webContentsId: number): void {
  startupLogSubscribers.delete(webContentsId);
  if (startupLogSubscribers.size === 0 && startupLogsInterval) {
    clearInterval(startupLogsInterval);
    startupLogsInterval = null;
  }
}

function getServerReadyPath(): string {
  return process.env.TX5DR_SERVER_READY_FILE?.trim() || path.join(getAppLogsDir(), 'server-ready.json');
}

function removeStaleServerReadyFile(): void {
  try {
    fs.unlinkSync(getServerReadyPath());
  } catch {
    // No stale ready file to remove.
  }
}

function getDevWebPort(): number {
  const value = Number(process.env.WEB_PORT || process.env.TX5DR_WEB_DEV_PORT || DEFAULT_WEB_HTTP_PORT);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_WEB_HTTP_PORT;
}

/**
 * 从 Server 配置目录读取 .admin-token 文件
 * Server 启动时会在配置目录写入该文件
 */
function readAdminTokenFile(): string | null {
  const tokenPath = path.join(getAppConfigDir(), '.admin-token');
  try {
    const token = fs.readFileSync(tokenPath, 'utf-8').trim();
    return token || null;
  } catch {
    return null;
  }
}

function getAdminTokenFileVersion(): string | null {
  try {
    const tokenStat = fs.statSync(path.join(getAppConfigDir(), '.admin-token'));
    return `${tokenStat.mtimeMs}:${tokenStat.size}`;
  } catch {
    return null;
  }
}

async function requestBackendJson(
  requestPath: string,
  options: { method?: string; body?: unknown; authorization?: string } = {},
): Promise<{ statusCode: number; body: unknown }> {
  if (!selectedServerPort) throw new Error('Backend server port is unavailable');

  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: selectedServerPort!,
      path: requestPath,
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
        ...(options.authorization ? { Authorization: options.authorization } : {}),
      },
      timeout: 5_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            return reject(new Error('Backend returned invalid JSON'));
          }
        }
        resolve({ statusCode: response.statusCode ?? 0, body });
      });
    });

    request.on('timeout', () => request.destroy(new Error('Backend request timed out')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function getBrowserLoginAuthService(): BrowserLoginAuthService {
  if (!browserLoginAuthService) {
    browserLoginAuthService = new BrowserLoginAuthService({
      requestJson: requestBackendJson,
      readAdminToken: readAdminTokenFile,
      getAdminTokenVersion: getAdminTokenFileVersion,
    });
  }
  return browserLoginAuthService;
}

async function buildAuthenticatedRendererUrl(baseUrl: string): Promise<string> {
  try {
    return await getBrowserLoginAuthService().buildAuthenticatedUrl(baseUrl);
  } catch (error) {
    logger.warn('automatic browser authentication failed; opening clean login page', error);
    return baseUrl;
  }
}

// 寻找可用端口（从起始端口开始递增尝试），可选避免指定端口冲突
async function findFreePort(
  start: number,
  maxStep = 50,
  avoid?: number,
  host = '0.0.0.0',
  options?: { fallbackToRandom?: boolean },
): Promise<number> {
  function tryPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => {
        srv.close(() => resolve(true));
      });
      srv.listen(port, host);
    });
  }
  for (let i = 0; i <= maxStep; i++) {
    const candidate = start + i;
    if (avoid && candidate === avoid) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await tryPort(candidate);
    if (ok) return candidate;
  }
  if (options?.fallbackToRandom === false) {
    throw new Error(`No free port found from ${start} to ${start + maxStep}`);
  }
  // 回退：让系统分配随机端口
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.once('listening', () => {
      const addr = srv.address();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const port = typeof addr === 'object' && addr && 'port' in addr ? (addr as any).port : 0;
      srv.close(() => resolve(port || start));
    });
    srv.listen(0, host);
  });
}

interface BackendLaunchFailureSummary {
  requestedPort: number;
  actualPort: number | null;
  reason: string;
  probe: string | null;
}

async function selectBackendPort(avoidPorts: ReadonlySet<number>): Promise<number> {
  const selection = await findAvailableBackendPort({
    startPort: DEFAULT_BACKEND_HTTP_PORT,
    scanSteps: DEFAULT_PORT_SCAN_STEPS,
    host: '0.0.0.0',
    avoidPorts,
    logger,
  });
  return selection.port;
}

function summarizePortDiagnostics(diagnostics: BackendPortDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return 'No occupied backend ports were diagnosed.';
  }
  return diagnostics
    .slice(0, 8)
    .map(diagnostic => `  - ${diagnostic.port}: ${summarizeProbeResult(diagnostic.probe)}`)
    .join('\n');
}

function summarizeBackendLaunchFailures(failures: BackendLaunchFailureSummary[]): string {
  if (failures.length === 0) {
    return 'No backend launch attempts completed a health probe.';
  }
  return failures
    .slice(-8)
    .map((failure) => {
      const actual = failure.actualPort === null ? 'unknown' : String(failure.actualPort);
      const probe = failure.probe ? `; ${failure.probe}` : '';
      return `  - requested ${failure.requestedPort}, actual ${actual}: ${failure.reason}${probe}`;
    })
    .join('\n');
}

function buildBackendStartupTroubleshootingDetail(
  requestedPort: number,
  failures: BackendLaunchFailureSummary[],
  error: unknown,
  realtimeFallbackHint: string,
): string {
  const failureSummary = summarizeBackendLaunchFailures(failures);
  const errorSummary = error instanceof Error ? error.message : String(error);
  return [
    `Requested backend port: ${requestedPort}. rtc-data-audio UDP port: ${process.env.RTC_DATA_AUDIO_UDP_PORT || '50110'}. ${realtimeFallbackHint}`,
    `Last backend probe error: ${errorSummary}`,
    'Diagnostics to run on Windows:',
    `  Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -ge ${DEFAULT_BACKEND_HTTP_PORT} -and $_.LocalPort -le ${DEFAULT_BACKEND_HTTP_PORT + DEFAULT_PORT_SCAN_STEPS} } | Select-Object LocalAddress,LocalPort,OwningProcess`,
    `  curl.exe -4 -v --max-time 5 http://127.0.0.1:${requestedPort}/`,
    'Backend launch attempts:',
    failureSummary,
  ].join('\n');
}

function triplet() {
  const arch = process.arch; // 'x64' | 'arm64'
  const plat = process.platform; // 'win32' | 'linux' | 'darwin'
  return `${plat}-${arch}`;
}

function resourcesRoot() {
  return app.isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, '..', '..', '..', 'resources');
}

function nodePath() {
  if (isDevelopmentRuntime() && process.env.TX5DR_DEV_NODE_PATH) {
    return process.env.TX5DR_DEV_NODE_PATH;
  }
  const res = resourcesRoot();
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  return path.join(res, 'bin', triplet(), exe);
}

async function ensureWindowsVCRuntimeInstalled(options: { present?: boolean } = {}): Promise<boolean> {
  if (process.platform !== 'win32') {
    return true;
  }

  const runtimeStatus = detectWindowsVCRuntime({
    resourcesRoot: resourcesRoot(),
    triplet: triplet(),
  });

  if (runtimeStatus.installed && runtimeStatus.versionOk) {
    logger.info(`windows VC runtime detected via ${runtimeStatus.source}: ${runtimeStatus.detail}`);
    return true;
  }

  const msgs = getMessages(app.getLocale());
  const isOutdated = runtimeStatus.installed && !runtimeStatus.versionOk;

  if (isOutdated) {
    logger.warn(
      `windows VC runtime version too old: ${runtimeStatus.version} (require >= ${VC_REDIST_MIN_VERSION.major}.${VC_REDIST_MIN_VERSION.minor})`,
    );
  } else {
    logger.error(`windows VC runtime check failed: ${runtimeStatus.detail}`);
  }

  const dialogMsgs = isOutdated ? msgs.vcRuntimeOutdated : msgs.vcRuntimeMissing;
  if (options.present !== false) {
    await createMainWindowOnly({ startHealthCheck: false, target: EMBEDDED_TARGET });
  }
  showStartupError('vc_runtime', {
    detail: `${dialogMsgs.message}\n${dialogMsgs.detail}`,
    actions: ['open-vc-runtime-download'],
    errorType: isOutdated ? 'VC_RUNTIME_OUTDATED' : 'VC_RUNTIME_MISSING',
  });

  return false;
}

// no quarantine/permission fallbacks; we assume portable node file is valid

function hasChildExited(proc: import('node:child_process').ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function forceKillChild(proc: import('node:child_process').ChildProcess, name: string): void {
  if (!proc.pid || hasChildExited(proc)) {
    return;
  }

  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGKILL');
    }
  } catch (error) {
    logger.error(`failed to force kill ${name}`, error);
  }
}

function killProcess(
  proc: import('node:child_process').ChildProcess | null,
  name: string,
  options: ChildShutdownOptions = {},
): Promise<ChildShutdownResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const softTimeoutMs = options.softTimeoutMs ?? 1500;
    const forceTimeoutMs = options.forceTimeoutMs ?? 500;

    if (!proc || hasChildExited(proc)) {
      resolve({
        name,
        durationMs: Date.now() - startedAt,
        forced: false,
        skipped: true,
      });
      return;
    }

    logger.info(`[child:${name}] stopping pid=${proc.pid ?? 'unknown'} signal=SIGTERM`);
    intentionalChildShutdowns.add(proc);

    let forced = false;
    let softTimer: NodeJS.Timeout | null = null;
    let forceTimer: NodeJS.Timeout | null = null;
    let finished = false;

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (softTimer) {
        clearTimeout(softTimer);
      }
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      proc.off('exit', onExit);
      resolve({
        name,
        durationMs: Date.now() - startedAt,
        forced,
        skipped: false,
      });
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      logger.info(`[child:${name}] stopped pid=${proc.pid ?? 'unknown'} code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      finish();
    };

    const escalate = () => {
      if (hasChildExited(proc)) {
        finish();
        return;
      }

      forced = true;
      logger.warn(`[child:${name}] stop timeout pid=${proc.pid ?? 'unknown'} forceSignal=SIGKILL`);
      forceKillChild(proc, name);

      forceTimer = setTimeout(() => {
        if (!hasChildExited(proc)) {
          logger.warn(`[child:${name}] did not exit after force kill pid=${proc.pid ?? 'unknown'}`);
        }
        finish();
      }, forceTimeoutMs);
    };

    proc.once('exit', onExit);
    softTimer = setTimeout(escalate, softTimeoutMs);

    try {
      proc.kill('SIGTERM');
    } catch (error) {
      logger.error(`failed to send SIGTERM to ${name}`, error);
      escalate();
    }
  });
}

function createChildEnv(extraEnv: Record<string, string> = {}) {
  const res = resourcesRoot();
  return buildChildRuntimeEnv({
    resourcesRoot: res,
    triplet: triplet(),
    currentEnv: process.env,
    extraEnv,
  });
}

function buildLogPathsHint(name: string): string {
  const logPath = log.transports.file.getFile().path;
  const logsDir = path.dirname(logPath);
  const serverLogPath = path.join(logsDir, 'tx5dr-server.log');
  const clientToolsLogPath = path.join(logsDir, 'client-tools.log');
  if (name === 'server') {
    return `Log files:\n  - ${serverLogPath}\n  - ${logPath}\n  - ${clientToolsLogPath}`;
  }
  if (name === 'client-tools') {
    return `Log files:\n  - ${clientToolsLogPath}\n  - ${logPath}\n  - ${serverLogPath}`;
  }
  return `Log files:\n  - ${logPath}\n  - ${serverLogPath}\n  - ${clientToolsLogPath}`;
}

function legacyStartupErrorType(kind: StartupErrorKind): string {
  switch (kind) {
    case 'vc_runtime':
      return 'VC_RUNTIME';
    case 'server_timeout':
    case 'web_timeout':
      return 'TIMEOUT';
    case 'port_conflict':
      return 'PORT_CONFLICT';
    case 'native_module':
      return 'NATIVE_MODULE';
    case 'child_crash':
      return 'CRASH';
    case 'child_start_failed':
      return 'START_FAILED';
    case 'unknown':
    default:
      return 'UNKNOWN';
  }
}

function sanitizeStartupErrorDetail(value: string): string {
  const knownPaths = [
    getAppLogsDir(),
    getServerReadyPath(),
    getClientToolsReadyPath(),
    log.transports.file.getFile().path,
  ];
  let result = value;
  for (const knownPath of knownPaths) {
    if (knownPath) {
      result = result.split(knownPath).join('[path omitted]');
    }
  }
  return result
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n')
    .trim();
}

function hasLoadingErrorSurface(): boolean {
  if (mainWindowInstance && !mainWindowInstance.isDestroyed() && !mainAppReadyForWindow) {
    return true;
  }

  for (const [id, contents] of startupLogSubscribers) {
    if (contents.isDestroyed()) {
      startupLogSubscribers.delete(id);
      continue;
    }
    return true;
  }

  return false;
}

function showStartupError(kind: StartupErrorKind, options: StartupErrorOptions = {}): void {
  if (startupErrorDialogShown) {
    return;
  }

  startupErrorDialogShown = true;
  hasStartupError = true;
  errorType = options.errorType || legacyStartupErrorType(kind);
  if (options.processName && !crashedProcessName) {
    crashedProcessName = options.processName;
  }

  embeddedRuntimeStatus = 'failed';
  const msgs = getMessages(app.getLocale()).startupErrors;
  const template = msgs[kind];
  // An embedded startup failure must never trap the user: a remote station stays reachable.
  const actionIds = [...new Set<StartupErrorActionId>([...(options.actions ?? []), 'open-station-manager'])];
  const actions = actionIds.map((id): StartupErrorAction => ({
    id,
    label: msgs.actions[id],
    style: 'primary',
  }));
  const detailParts = [
    template.detail,
    options.detail ? sanitizeStartupErrorDetail(options.detail) : null,
    msgs.logHint,
  ].filter((part): part is string => Boolean(part));

  startupErrorState = {
    kind,
    title: template.title,
    message: template.message,
    detail: detailParts.join('\n'),
    processName: options.processName,
    actions,
  };

  logger.error('startup error state updated', {
    kind,
    processName: options.processName ?? null,
    errorType,
    detail: startupErrorState.detail,
    error: options.error,
  });

  broadcastStartupLogPayload(createStartupLogsPayload(false, []));
  broadcastStationState();

  if (!hasLoadingErrorSurface() && remoteStationWindows.size === 0) {
    dialog.showErrorBox(
      startupErrorState.title,
      `${startupErrorState.message}\n\n${startupErrorState.detail ?? ''}`,
    );
  }
}

function wireChildProcess(name: string, child: import('node:child_process').ChildProcess) {
  const MAX_STDERR_LINES = 20;
  const recentStderr: string[] = [];

  child.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().trimEnd();
    if (lines) logger.debug(`[child:${name}] ${lines}`);
  });
  child.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().trimEnd();
    if (lines) {
      // stderr carries console.warn, console.error and runtime warnings alike, so it is
      // not a severity signal. Children keep leveled logs in their own files, and exits
      // are reported with the recent stderr lines below.
      logger.warn(`[child:${name}] ${lines}`);
      for (const line of lines.split('\n')) {
        recentStderr.push(line);
        if (recentStderr.length > MAX_STDERR_LINES) recentStderr.shift();
      }
    }
  });

  child.on('exit', (code, signal) => {
    logger.info(`[child:${name}] exited pid=${child.pid ?? 'unknown'} code=${code ?? 'null'} signal=${signal ?? 'null'}`);

    if (isQuitting) return;

    if (intentionalChildShutdowns.delete(child)) {
      logger.info(`[child:${name}] intentional shutdown complete`);
      return;
    }

    if (code !== 0) {
      if (!errorType) {
        errorType = 'CRASH';
      }
      if (!crashedProcessName) {
        crashedProcessName = name;
      }
      hasStartupError = true;
      const reason = signal ? `killed by signal ${signal}` : `abnormal exit (code: ${code})`;
      const stderrHint = recentStderr.length > 0
        ? `\n\nRecent stderr:\n${recentStderr.join('\n')}`
        : '';
      const detail = `${name} process ${reason}\n\n${buildLogPathsHint(name)}${stderrHint}`;
      if (mainAppReadyForWindow && !aliveWindow(mainWindowInstance) && remoteStationWindows.size > 0) {
        embeddedRuntimeStatus = 'failed';
        broadcastStationState();
        logger.error(`embedded ${detail}`);
        return;
      }
      if (!mainAppReadyForWindow) {
        showStartupError('child_crash', {
          processName: name,
          detail: recentStderr.length > 0
            ? `${name} process ${reason}. Recent stderr: ${recentStderr.slice(-3).join(' | ')}`
            : `${name} process ${reason}.`,
          actions: process.platform === 'win32' && name === 'server' ? ['open-vc-runtime-download'] : undefined,
        });
        return;
      }
      dialog.showErrorBox('TX-5DR - Startup Failed',
        detail);
    }
  });

  child.on('error', (err) => {
    logger.error(`[child:${name}] failed to start: ${err.message}`);
    if (!crashedProcessName) {
      crashedProcessName = name;
    }
    hasStartupError = true;
    if (!mainAppReadyForWindow) {
      showStartupError('child_start_failed', {
        processName: name,
        detail: err.message,
        error: err,
      });
      return;
    }
    dialog.showErrorBox('TX-5DR - Startup Failed',
      `${name} process failed to start: ${err.message}\n\n${buildLogPathsHint(name)}`);
  });
}

function runChild(name: string, entryAbs: string, extraEnv: Record<string, string> = {}) {
  const NODE = nodePath();
  if (!fs.existsSync(NODE)) {
    logger.error(`[child:${name}] node binary not found: ${NODE}`);
  }
  if (!fs.existsSync(entryAbs)) {
    logger.error(`[child:${name}] entry not found: ${entryAbs}`);
  }

  logger.info(`[child:${name}] starting entry=${entryAbs} cwd=${path.dirname(entryAbs)} node=${NODE}`);
  const child = spawn(NODE, [entryAbs], {
    cwd: path.dirname(entryAbs),
    env: createChildEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  logger.info(`[child:${name}] started pid=${child.pid ?? 'unknown'}`);
  wireChildProcess(name, child);
  return child;
}

/**
 * Run the native module diagnostic script in an isolated child process.
 * Returns a structured result even if the child crashes or times out.
 */
function runNativeModuleCheck(
  serverEntry: string,
): Promise<NativeModuleCheckResult> {
  const CHECK_TIMEOUT_MS = 30_000;
  const scriptPath = path.join(path.dirname(serverEntry), 'scripts', 'check-native-modules.js');

  if (!fs.existsSync(scriptPath)) {
    logger.warn(`native module check script not found: ${scriptPath}, skipping`);
    return Promise.resolve({
      success: true, modules: [], crashedModule: null,
      exitCode: null, signal: null, timeout: false,
    });
  }

  return new Promise((resolve) => {
    const NODE = nodePath();
    const child = spawn(NODE, [scriptPath], {
      cwd: path.dirname(serverEntry),
      env: createChildEnv({}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const modules: NativeModuleCheckResult['modules'] = [];
    let lastChecking: string | null = null;
    let settled = false;
    let stdoutBuf = '';

    const finish = (result: NativeModuleCheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout!.on('data', (data: Buffer) => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split('\n');
      // Keep the last (possibly incomplete) chunk for next data event
      stdoutBuf = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith('CHECKING:')) {
          lastChecking = line.slice('CHECKING:'.length);
        } else if (line.startsWith('OK:')) {
          modules.push({ name: line.slice('OK:'.length), ok: true });
          lastChecking = null;
        } else if (line.startsWith('FAIL:')) {
          const rest = line.slice('FAIL:'.length);
          const idx = rest.indexOf(':');
          const name = idx >= 0 ? rest.slice(0, idx) : rest;
          const error = idx >= 0 ? rest.slice(idx + 1) : '';
          modules.push({ name, ok: false, error });
          lastChecking = null;
        }
        // DONE and ERROR lines are informational; exit event handles completion
      }
    });

    child.stderr!.on('data', (data: Buffer) => {
      logger.debug(`[native-check] ${data.toString().trimEnd()}`);
    });

    child.on('exit', (code, signal) => {
      finish(buildNativeModuleCheckExitResult({
        code,
        signal: signal as string | null,
        modules,
        lastChecking,
      }));
    });

    child.on('error', (err) => {
      logger.error(`native module check process error: ${err.message}`);
      finish({
        success: false, modules, crashedModule: lastChecking,
        exitCode: null, signal: null, timeout: false,
      });
    });

    const timer = setTimeout(() => {
      logger.warn('native module check timed out, killing');
      child.kill('SIGKILL');
      finish({
        success: false, modules, crashedModule: lastChecking,
        exitCode: null, signal: null, timeout: true,
      });
    }, CHECK_TIMEOUT_MS);
  });
}

async function waitForHttp(url: string, timeoutMs = 15000, intervalMs = 300): Promise<boolean> {
  return waitForUrl(url, timeoutMs, intervalMs);
}

interface WebGatewayReadyState {
  pid?: number;
  requestedPort?: number;
  httpPort: number | null;
  httpOk: boolean;
  requestedHttpsPort?: number;
  httpsPort: number | null;
  httpsOk: boolean;
  httpsEnabled?: boolean;
  staticDir?: string;
  staticDirExists?: boolean;
  target?: string;
  devWebTarget?: string | null;
  error?: unknown;
}

function isValidPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) < 65536;
}

function readServerReadyFile(minTimestampMs?: number): ServerReadyState | null {
  try {
    const raw = fs.readFileSync(getServerReadyPath(), 'utf-8');
    const parsed = JSON.parse(raw) as ServerReadyState;
    if (minTimestampMs && parsed.timestamp) {
      const timestampMs = Date.parse(parsed.timestamp);
      if (Number.isFinite(timestampMs) && timestampMs < minTimestampMs) {
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

async function waitForServerReady(
  timeoutMs = 15000,
  intervalMs = 200,
  minTimestampMs?: number,
  options: { healthFailureTimeoutMs?: number } = {},
): Promise<ServerReadyState> {
  try {
    return await waitForServerReadyWithProbe({
      readyFile: getServerReadyPath(),
      readReadyFile: () => readServerReadyFile(minTimestampMs),
      timeoutMs,
      intervalMs,
      healthFailureTimeoutMs: options.healthFailureTimeoutMs,
      logger,
    });
  } catch (error) {
    if (error instanceof ServerReadyTimeoutError) {
      throw new Error(`server_ready_timeout:${JSON.stringify({
        readyFile: getServerReadyPath(),
        timeoutMs,
        lastReady: error.lastReady,
        lastProbe: error.lastProbe,
      })}`);
    }
    throw error;
  }
}

function readWebGatewayReadyFile(expectedPid?: number): WebGatewayReadyState | null {
  try {
    const raw = fs.readFileSync(getClientToolsReadyPath(), 'utf-8');
    const parsed = JSON.parse(raw) as WebGatewayReadyState;
    if (expectedPid && parsed.pid && parsed.pid !== expectedPid) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function waitForWebGatewayReady(
  env: Record<string, string>,
  webPort: number,
  timeoutMs = 15000,
  intervalMs = 200,
  expectedPid?: number,
): Promise<WebGatewayReadyState> {
  const started = Date.now();
  let ready: WebGatewayReadyState | null = null;
  while (Date.now() - started <= timeoutMs) {
    ready = readWebGatewayReadyFile(expectedPid);
    if (ready) break;
    await new Promise(r => setTimeout(r, intervalMs));
  }

  if (!ready) {
    logger.warn('web gateway ready file not found, falling back to HTTP probe', {
      readyFile: getClientToolsReadyPath(),
      expectedPid,
      webPort,
    });
    const probeOk = await waitForUrl(`http://127.0.0.1:${webPort}`, timeoutMs, intervalMs);
    ready = {
      httpPort: webPort,
      httpOk: probeOk,
      httpsPort: null,
      httpsOk: false,
      target: env.TARGET,
        devWebTarget: env.DEV_WEB_TARGET ?? null,
    };
  }

  if (!ready.httpOk || !ready.httpPort) {
    throw new Error(`web_gateway_bind_failed:${JSON.stringify(ready.error ?? {})}`);
  }

  const httpOk = await waitForUrl(`http://127.0.0.1:${ready.httpPort}`, timeoutMs, intervalMs);
  if (!httpOk) {
    throw new Error(`web_service_restart_timeout:http:${ready.httpPort}`);
  }

  if (ready.httpsOk && ready.httpsPort) {
    const httpsOk = await waitForUrl(`https://127.0.0.1:${ready.httpsPort}`, timeoutMs, intervalMs);
    if (!httpsOk) {
      logger.warn('web HTTPS endpoint did not respond after ready signal', {
        httpsPort: ready.httpsPort,
        requestedHttpsPort: ready.requestedHttpsPort,
      });
      ready.httpsOk = false;
      ready.httpsPort = null;
    }
  } else if (env.HTTPS_ENABLE === '1') {
    logger.warn('web HTTPS endpoint is disabled or unavailable', {
      requestedHttpsPort: ready.requestedHttpsPort,
      error: ready.error ?? null,
    });
  }

  return ready;
}

/**
 * 构建右键菜单（托盘和 Dock 共用）
 */
function buildContextMenu(includQuit: boolean): Menu {
  const msgs = getMessages(app.getLocale());
  const template: Parameters<typeof Menu.buildFromTemplate>[0] = [
    { label: msgs.menu.about, click: () => { void openAboutWindow(); } },
    { type: 'separator' },
    { label: msgs.menu.openMainWindow, click: () => showMainWindow() },
    { label: msgs.menu.openDevTools, click: () => { void openMainWindowDevTools(); } },
    { label: msgs.menu.logViewer, click: () => openLogInTerminal() },
    { type: 'separator' },
    { label: msgs.menu.openInBrowser, click: () => openInBrowser() },
    { type: 'separator' },
    ...buildStationMenuItems(),
  ];

  if (includQuit) {
    template.push(
      { type: 'separator' },
      {
        label: msgs.menu.quit,
        click: () => {
          void cleanupAndQuit('tray-menu');
        },
      },
    );
  }

  return Menu.buildFromTemplate(template);
}

/**
 * 创建 Windows/Linux 系统托盘
 */
function createTray() {
  if (process.platform === 'darwin') return;
  if (trayInstance) return;

  const iconPath = process.platform === 'win32'
    ? (app.isPackaged
        ? path.join(process.resourcesPath, 'app', 'packages', 'electron-main', 'assets', 'AppIcon.ico')
        : path.join(__dirname, '..', 'assets', 'AppIcon.ico'))
    : (app.isPackaged
        ? path.join(process.resourcesPath, 'app', 'packages', 'electron-main', 'assets', 'AppIcon.png')
        : path.join(__dirname, '..', 'assets', 'AppIcon.png'));

  trayInstance = new Tray(iconPath);
  trayInstance.setToolTip('TX-5DR Digital Radio');
  trayInstance.setContextMenu(buildContextMenu(true));

  // 双击托盘图标打开主窗口（Windows 惯例）
  trayInstance.on('double-click', () => {
    showMainWindow();
  });

  logger.info('system tray created');
}

/**
 * 创建 macOS Dock 菜单
 */
function createDockMenu() {
  if (process.platform !== 'darwin') return;
  if (!app.dock) return;

  // Dock 菜单不含"退出"（macOS 有标准退出方式 Cmd+Q）
  app.dock.setMenu(buildContextMenu(false));
  logger.info('dock menu created');
}

/**
 * 打开/聚焦"关于"窗口（单例）
 */
async function openAboutWindow(target: StationWindowTarget = getActiveStationTarget()): Promise<void> {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    if (aboutWindow.isMinimized()) aboutWindow.restore();
    aboutWindow.focus();
    return;
  }
  if (target.kind === 'remote') configureRemoteStationSession(target);

  try {
    aboutWindow = new BrowserWindow({
      width: 720,
      height: 760,
      minWidth: 600,
      minHeight: 500,
      resizable: true,
      maximizable: false,
      minimizable: true,
      show: true,
      titleBarStyle: 'hiddenInset',
      titleBarOverlay: process.platform === 'win32' ? {
        color: '#ffffff',
        symbolColor: '#000000',
      } : false,
      frame: process.platform !== 'darwin',
      webPreferences: stationWebPreferences(target),
    });
    attachStationWindowGuards(aboutWindow);

    if (process.platform === 'win32' || process.platform === 'linux') {
      aboutWindow.setMenuBarVisibility(false);
    }

    const aboutUrl = `${stationOriginOf(target)}/about.html`;
    logger.info(`opening about window at ${aboutUrl}`);
    await aboutWindow.loadURL(aboutUrl);

    if (process.env.NODE_ENV === 'development' && !app.isPackaged && shouldOpenDevTools()) {
      aboutWindow.webContents.openDevTools();
    }

    aboutWindow.focus();

    aboutWindow.on('closed', () => {
      aboutWindow = null;
    });
  } catch (error) {
    logger.error('failed to open about window', error);
    aboutWindow = null;
  }
}

/**
 * 创建 macOS 应用顶部菜单（Cmd+Q/W/C/V 等需要保留 role 项）
 */
function createApplicationMenu() {
  if (process.platform !== 'darwin') return;
  const msgs = getMessages(app.getLocale());
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { label: msgs.menu.about, click: () => { void openAboutWindow(); } },
        { type: 'separator' },
        ...buildStationMenuItems(),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'GitHub',
          click: () => { void shell.openExternal('https://github.com/boybook/tx-5dr'); },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  logger.info('application menu created (macOS)');
}

/**
 * 获取当前 web 界面 URL
 */
function getWebUrl(): string {
  if (process.env.NODE_ENV === 'development' && !app.isPackaged && !selectedWebPort) {
    return `http://localhost:${getDevWebPort()}`;
  }
  return `http://127.0.0.1:${selectedWebPort || DEFAULT_WEB_HTTP_PORT}`;
}

function getPreloadPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app', 'packages', 'electron-preload', 'dist', 'preload.js')
    : join(__dirname, '../../electron-preload/dist/preload.js');
}

/**
 * Web preferences for windows showing the embedded station. The preload learns
 * the granted bridge capabilities from the command-line switches; the main
 * process still enforces them per IPC call.
 */
function embeddedStationWebPreferences(options: { pluginPage?: boolean } = {}): Electron.WebPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: false,
    allowRunningInsecureContent: true,
    backgroundThrottling: false,
    preload: getPreloadPath(),
    additionalArguments: buildBridgeArguments('embedded', getShellPageUrls(), options),
  };
}

function getLoadingPagePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app', 'packages', 'electron-main', 'assets', 'loading.html')
    : join(__dirname, '../assets/loading.html');
}

async function loadMainAppInWindow(windowInstance: BrowserWindow): Promise<void> {
  if (windowInstance.isDestroyed()) {
    logger.warn('cannot load main app because window is destroyed');
    return;
  }

  const webUrl = getWebUrl();
  const urlWithAuth = await buildAuthenticatedRendererUrl(webUrl);
  logger.info(`loading URL: ${redactSensitiveText(urlWithAuth)}`);
  await windowInstance.loadURL(urlWithAuth);
}

function closeMainWindowToBackground(windowInstance: BrowserWindow, reason: string): void {
  logger.info(`destroying main window renderer for background mode (${reason})`);
  windowInstance.destroy();
  logDevProcessMemory(`main-window-destroy:${reason}`);
}

/**
 * 仅创建主窗口（不启动子进程），用于托盘/Dock恢复窗口
 */
async function createMainWindowOnly(options: CreateMainWindowOptions = {}): Promise<BrowserWindow> {
  configureNotificationPermissionHandlers();
  const target = options.target ?? getActiveStationTarget();
  if (target.kind === 'remote') configureRemoteStationSession(target);

  // Each station has at most one station window; reuse it when it is still open.
  const existingWindow = getStationWindow(stationIdOf(target));
  if (existingWindow) {
    existingWindow.show();
    existingWindow.focus();
    return existingWindow;
  }
  if (target.kind === 'embedded') {
    mainWindowInstance = null;
  }

  const isDevelopment = isDevelopmentRuntime();

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff',
    titleBarStyle: 'hiddenInset',
    titleBarOverlay: process.platform === 'win32' ? {
      color: nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#000000'
    } : false,
    frame: process.platform !== 'darwin',
    webPreferences: stationWebPreferences(target),
  });

  logger.info('station window created', { station: stationIdOf(target) });
  const mainWindowWebContentsId = mainWindow.webContents.id;
  if (target.kind === 'embedded') mainWindowInstance = mainWindow;
  else remoteStationWindows.set(target.profile.id, mainWindow);
  lastFocusedStationWindow = mainWindow;
  mainWindow.on('focus', () => noteStationWindowFocused(mainWindow, stationIdOf(target)));
  attachStationWindowGuards(mainWindow);

  // Windows/Linux: 关闭窗口时询问用户行为；后台模式销毁 renderer，避免隐藏窗口继续占用内存。
  if (process.platform !== 'darwin') {
    mainWindow.on('close', (event) => {
      if (isQuitting) return;

      // While another station window stays open, closing one station only closes
      // that window; the embedded server keeps running as in background mode.
      if (hasOtherStationWindow(mainWindow)) {
        if (target.kind === 'embedded') {
          event.preventDefault();
          closeMainWindowToBackground(mainWindow, 'other-station-open');
        }
        return;
      }

      const settings = loadElectronSettings();

      if (settings.closeBehavior === 'tray') {
        event.preventDefault();
        closeMainWindowToBackground(mainWindow, 'saved-tray');
        return;
      }

      if (settings.closeBehavior === 'quit') {
        void cleanupAndQuit('window-close');
        return;
      }

      // closeBehavior === 'ask'
      event.preventDefault();

      const msgs = getMessages(app.getLocale());

      dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: msgs.closeWindow.buttons,
        defaultId: 0,
        cancelId: 2,
        title: 'TX-5DR',
        message: msgs.closeWindow.message,
        detail: msgs.closeWindow.detail,
        checkboxLabel: msgs.closeWindow.checkboxLabel,
        checkboxChecked: false,
      }).then(({ response, checkboxChecked }) => {
        if (response === 0) {
          if (checkboxChecked) {
            saveElectronSettings({ ...settings, closeBehavior: 'tray' });
          }
          closeMainWindowToBackground(mainWindow, 'ask-tray');
        } else if (response === 1) {
          if (checkboxChecked) {
            saveElectronSettings({ ...settings, closeBehavior: 'quit' });
          }
          void cleanupAndQuit('window-close');
        }
      });
    });
  }

  mainWindow.on('closed', () => {
    logger.info('station window closed', { station: stationIdOf(target) });
    voicePttShortcutCaptures.delete(mainWindowWebContentsId);
    if (lastFocusedStationWindow === mainWindow) lastFocusedStationWindow = null;
    if (target.kind === 'remote') {
      if (remoteStationWindows.get(target.profile.id) === mainWindow) remoteStationWindows.delete(target.profile.id);
      refreshStationMenus();
      broadcastStationState();
      return;
    }
    if (mainWindowInstance !== mainWindow) return;
    mainWindowInstance = null;
    refreshStationMenus();
    if (serverCheckInterval) {
      clearInterval(serverCheckInterval);
      serverCheckInterval = null;
    }
  });

  // Ignore subframe failures so broken plugin/external iframes do not get
  // misclassified as a fatal app startup error.
  mainWindow.webContents.on(
    'did-fail-load',
    (
      _event,
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
    ) => {
      if (!isMainFrame) {
        logger.warn(`subframe load failed: ${errorCode} - ${errorDescription} (${validatedURL})`);
        return;
      }

      if (target.kind === 'remote') {
        handleRemoteStationLoadFailure(mainWindow, target, errorCode, errorDescription, validatedURL);
        return;
      }

      logger.error(`page load failed: ${errorCode} - ${errorDescription} (${validatedURL})`);
      errorType = 'UNKNOWN';
      hasStartupError = true;
      mainWindow.close();
      const logPath = log.transports.file.getFile().path;
      dialog.showErrorBox(
        'TX-5DR - Page Load Failed',
        `Error ${errorCode}: ${errorDescription}\nURL: ${validatedURL}\n\nLog file: ${logPath}`,
      );
    },
  );

  if (target.kind === 'remote') {
    // The gateway answers 495/502/503 when the station is gone or its certificate
    // changed; re-probe so the connect page shows the actual reason.
    mainWindow.webContents.on('did-navigate', (_event, url, httpResponseCode) => {
      if (![495, 502, 503].includes(httpResponseCode)) return;
      const binding = remoteStationSessions.get(mainWindow.webContents.session);
      if (!binding || !url.startsWith(binding.origin)) return;
      logger.warn('remote station gateway reported an upstream failure', { station: target.profile.id, httpResponseCode });
      const current = stationTargetById(target.profile.id);
      if (current?.kind !== 'remote') return;
      void loadStationManagerPage(mainWindow, { mode: 'connect', station: target.profile.id })
        .then(() => connectRemoteStation(current, mainWindow))
        .catch(error => logger.warn('failed to reconnect remote station', error));
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mainWindow.webContents.on('render-process-gone', (_event: any, details: any) => {
    logger.error('renderer process gone', details);
  });

  // Single-argument form: Electron flags the positional (event, level, message, ...)
  // listener as deprecated and removes it in a later major.
  mainWindow.webContents.on('console-message', ({ level, message }) => {
    logger.debug(`console [${level}]: ${message}`);
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (shortcutRecordingActionId) {
      if (shortcutRecordingWebContentsId !== mainWindow.webContents.id) {
        return;
      }

      event.preventDefault();
      if (input.type !== 'keyDown' || input.isAutoRepeat) {
        return;
      }

      const actionId = shortcutRecordingActionId;
      if (input.key === 'Escape') {
        stopShortcutRecording({ restoreGlobalShortcuts: true });
        mainWindow.webContents.send('shortcut:recording-cancelled', { actionId } satisfies ShortcutRecordingCancelledPayload);
        return;
      }

      if (isModifierOnlyShortcutInput(input)) {
        return;
      }

      const binding = createShortcutBindingFromElectronInput(input);
      if (!binding) {
        return;
      }

      stopShortcutRecording({ restoreGlobalShortcuts: true });
      mainWindow.webContents.send('shortcut:recorded', { actionId, binding } satisfies ShortcutRecordedPayload);
      return;
    }

    handleVoicePttShortcutInput(event, input, mainWindow.webContents);
  });

  if (process.platform === 'win32' || process.platform === 'linux') {
    mainWindow.setMenuBarVisibility(false);
  }

  // 定期检查服务器健康状态（仅内嵌电台）
  if (options.startHealthCheck !== false && target.kind === 'embedded') {
    serverCheckInterval = setInterval(async () => {
      const isHealthy = await checkServerHealth();
      if (!isHealthy) {
        if (isDevelopment) {
          logger.debug('external server connection lost (development mode)');
        } else {
          logger.debug('embedded server connection lost');
        }
      }
    }, 10000);
  }

  // 先加载本地页面，避免白屏：内嵌电台显示启动进度，远程电台显示连接状态。
  if (target.kind === 'remote') {
    await loadStationManagerPage(mainWindow, { mode: 'connect', station: target.profile.id });
  } else {
    await mainWindow.loadFile(getLoadingPagePath());
  }

  // 显示窗口（此时展示 loading 动画）
  mainWindow.show();
  mainWindow.focus();
  mainWindow.moveTop();

  if (process.platform === 'darwin') {
    app.focus({ steal: true });
    if (app.dock) {
      app.dock.bounce('critical');
    }
  }

  return mainWindow;
}

/**
 * 确保主窗口存在并可见，若已销毁则重新创建（不重启子进程）
 */
async function ensureMainWindowVisible(): Promise<BrowserWindow> {
  let windowInstance = aliveWindow(lastFocusedStationWindow) ?? listStationWindows()[0] ?? null;

  if (!windowInstance) {
    const target = getActiveStationTarget();
    windowInstance = await createMainWindowOnly({ target });
    if (target.kind === 'remote') {
      void connectRemoteStation(target, windowInstance);
    } else if (mainAppReadyForWindow) {
      await loadMainAppInWindow(windowInstance);
    }
  }

  if (windowInstance.isMinimized()) {
    windowInstance.restore();
  }
  windowInstance.show();
  windowInstance.focus();

  return windowInstance;
}

/**
 * 显示主窗口，若已销毁则重新创建（不重启子进程）
 */
function showMainWindow() {
  void ensureMainWindowVisible().catch((error) => {
    logger.error('failed to show main window', error);
  });
}

async function openMainWindowDevTools(): Promise<void> {
  try {
    const windowInstance = await ensureMainWindowVisible();
    if (windowInstance.isDestroyed()) {
      logger.warn('cannot open main window DevTools because window is destroyed');
      return;
    }

    logger.info('opening main window DevTools');
    windowInstance.webContents.openDevTools();
  } catch (error) {
    logger.error('failed to open main window DevTools', error);
  }
}

/**
 * 在系统原生终端中打开日志（tail -f）
 * 同时监控 electron 主进程日志和 server 日志
 */
function openLogInTerminal() {
  const electronLogPath = log.transports.file.getFile().path;
  const logDir = path.dirname(electronLogPath);
  const serverLogPath = path.join(logDir, 'tx5dr-server.log');
  const clientToolsLogPath = path.join(logDir, 'client-tools.log');
  logger.info(`opening logs in terminal: ${logDir}`);

  // 收集存在的日志文件
  const logFiles = [electronLogPath];
  if (fs.existsSync(serverLogPath)) {
    logFiles.push(serverLogPath);
  }
  if (fs.existsSync(clientToolsLogPath)) {
    logFiles.push(clientToolsLogPath);
  }
  const tailTarget = logFiles.map(f => `"${f}"`).join(' ');

  try {
    if (process.platform === 'darwin') {
      const script = path.join(app.getPath('temp'), 'tx5dr-tail.sh');
      fs.writeFileSync(script, [
        '#!/bin/bash',
        `echo "TX-5DR Log Viewer"`,
        `echo "Log directory: ${logDir}"`,
        `echo "Monitoring files: ${logFiles.map(f => path.basename(f)).join(', ')}"`,
        `echo "Press Ctrl+C to exit"`,
        `echo ""`,
        `tail -f ${tailTarget}`,
      ].join('\n'), { mode: 0o755 });
      spawn('open', ['-a', 'Terminal', script]);
    } else if (process.platform === 'win32') {
      // Windows: use PowerShell directly in a new window via start
      const psFiles = logFiles.map(f => `'${f}'`).join(', ');
      const psCommand = `$Host.UI.RawUI.WindowTitle = 'TX-5DR Log Viewer'; Get-Content ${psFiles} -Wait -Tail 50`;
      spawn('cmd', ['/c', 'start', 'powershell', '-NoExit', '-Command', psCommand], { shell: true });
    } else {
      const tailCmd = `tail -f ${tailTarget}`;
      const terminals = [
        { bin: '/usr/bin/x-terminal-emulator', args: ['-e', tailCmd] },
        { bin: '/usr/bin/gnome-terminal', args: ['--', 'bash', '-c', tailCmd] },
        { bin: '/usr/bin/konsole', args: ['-e', 'bash', '-c', tailCmd] },
        { bin: '/usr/bin/xfce4-terminal', args: ['-e', tailCmd] },
        { bin: '/usr/bin/xterm', args: ['-e', tailCmd] },
      ];

      const found = terminals.find(t => fs.existsSync(t.bin));
      if (found) {
        spawn(found.bin, found.args, { detached: true, stdio: 'ignore' });
      } else {
        logger.warn('no terminal emulator found');
        dialog.showErrorBox('TX-5DR', `No terminal emulator found\n\nLog directory: ${logDir}`);
      }
    }
  } catch (err) {
    logger.error('failed to open terminal', err);
    dialog.showErrorBox('TX-5DR', `Failed to open terminal\n\nLog directory: ${logDir}`);
  }
}

/**
 * 在系统浏览器中打开 web 界面（附带认证 token）
 */
async function openInBrowser() {
  const active = getActiveStationTarget();
  if (active.kind === 'remote') {
    await shell.openExternal(active.profile.url);
    return;
  }
  // The embedded station page; its browser entrypoint may use desktop HTTPS.
  const status = await getDesktopHttpsStatus().catch(() => null);
  const base = status?.browserAccessUrl || getWebUrl();

  if (status?.usingSelfSigned) {
    const msgs = getMessages(app.getLocale());
    await dialog.showMessageBox({
      type: 'info',
      title: 'TX-5DR',
      message: msgs.httpsSelfSigned?.title || 'Self-signed certificate',
      detail: msgs.httpsSelfSigned?.detail || 'Your browser may show a security warning the first time. Continue manually if you trust this device.',
      buttons: ['OK'],
      noLink: true,
    });
  }

  const url = await buildAuthenticatedRendererUrl(base);
  await shell.openExternal(url);
}

function redactSensitiveUrl(value: string): string {
  return redactSensitiveText(value);
}

function formatMetricMemory(value: number | undefined): string | null {
  if (typeof value !== 'number') {
    return null;
  }
  return `${(value / 1024).toFixed(1)}MB`;
}

function getWindowMetadataByPid(): Map<number, Array<Record<string, unknown>>> {
  const windowsByPid = new Map<number, Array<Record<string, unknown>>>();

  for (const windowInstance of BrowserWindow.getAllWindows()) {
    try {
      if (windowInstance.isDestroyed()) {
        continue;
      }

      const pid = windowInstance.webContents.getOSProcessId();
      const windows = windowsByPid.get(pid) ?? [];
      windows.push({
        id: windowInstance.id,
        title: windowInstance.getTitle(),
        visible: windowInstance.isVisible(),
        minimized: windowInstance.isMinimized(),
        url: redactSensitiveUrl(windowInstance.webContents.getURL()),
      });
      windowsByPid.set(pid, windows);
    } catch (error) {
      logger.warn('failed to collect window metadata for process memory log', error);
    }
  }

  return windowsByPid;
}

function logDevProcessMemory(reason: string): void {
  if (!shouldLogDevProcessMemory()) {
    return;
  }

  try {
    const windowsByPid = getWindowMetadataByPid();
    const processes = app.getAppMetrics()
      .map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        name: metric.name ?? null,
        serviceName: metric.serviceName ?? null,
        workingSet: formatMetricMemory(metric.memory.workingSetSize),
        peakWorkingSet: formatMetricMemory(metric.memory.peakWorkingSetSize),
        privateBytes: formatMetricMemory(metric.memory.privateBytes),
        cpuPercent: Number(metric.cpu.percentCPUUsage.toFixed(1)),
        windows: windowsByPid.get(metric.pid) ?? [],
      }))
      .sort((left, right) => {
        const rightMemory = right.workingSet ? Number.parseFloat(right.workingSet) : 0;
        const leftMemory = left.workingSet ? Number.parseFloat(left.workingSet) : 0;
        return rightMemory - leftMemory;
      });

    const topProcesses = processes.slice(0, 3).map((process) => (
      `${process.pid}:${process.type}:${process.name ?? 'unknown'}:${process.workingSet}`
    )).join(', ');
    logger.info(
      `dev electron process memory reason=${reason} webPid=${webProcess?.pid ?? 'none'} serverPid=${serverProcess?.pid ?? 'none'} processCount=${processes.length} top=${topProcesses || 'none'}`,
    );
  } catch (error) {
    logger.warn('failed to collect dev electron process memory', error);
  }
}

function startDevProcessMemoryLogger(): void {
  if (!shouldLogDevProcessMemory() || devProcessMemoryLogInterval) {
    return;
  }

  logDevProcessMemory('startup');
  devProcessMemoryLogInterval = setInterval(() => {
    logDevProcessMemory('interval');
  }, DEV_PROCESS_MEMORY_LOG_INTERVAL_MS);
}

function stopDevProcessMemoryLogger(): void {
  if (!devProcessMemoryLogInterval) {
    return;
  }
  clearInterval(devProcessMemoryLogInterval);
  devProcessMemoryLogInterval = null;
}

async function checkServerHealth(): Promise<boolean> {
  const port = selectedServerPort || 4000;
  const baseUrl = `http://127.0.0.1:${port}`;
  logger.debug(`health check: connecting to ${baseUrl}/`);
  return (await probeTx5drServer(baseUrl)).ok;
}

async function prepareEmbeddedServerShutdown(reason: string): Promise<boolean> {
  if (!selectedServerPort || !internalShutdownToken) {
    return false;
  }

  const port = selectedServerPort;
  const token = internalShutdownToken;
  const body = JSON.stringify({ reason });
  const timeoutMs = 35_000;
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/system/internal/prepare-shutdown',
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-tx5dr-internal-token': token,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const payload = Buffer.concat(chunks).toString('utf8');
        if (isPrepareShutdownSuccess(res.statusCode, payload)) {
          logger.info('embedded server prepared for shutdown', { reason, statusCode: res.statusCode, payload });
          resolve(true);
        } else {
          logger.warn('embedded server prepare-shutdown failed', { reason, statusCode: res.statusCode, payload });
          resolve(false);
        }
      });
    });
    req.on('timeout', () => {
      logger.warn('embedded server prepare-shutdown timed out', { reason, timeoutMs });
      req.destroy();
      resolve(false);
    });
    req.on('error', (error) => {
      logger.warn('embedded server prepare-shutdown request failed', { reason, error: error.message });
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

function closeFrontendWindowsImmediately(): number {
  const startedAt = Date.now();

  if (serverCheckInterval) {
    clearInterval(serverCheckInterval);
    serverCheckInterval = null;
  }

  const windows = BrowserWindow.getAllWindows();
  logger.info(`closing frontend windows immediately (${windows.length} windows)`);

  for (const windowInstance of windows) {
    try {
      if (!windowInstance.isDestroyed()) {
        windowInstance.destroy();
      }
    } catch (error) {
      logger.warn('failed to destroy window during quit', error);
    }
  }

  mainWindowInstance = null;
  return Date.now() - startedAt;
}

async function stopServerAfterStartupFailure(reason: string): Promise<void> {
  const currentServerProcess = serverProcess;
  if (!currentServerProcess) {
    return;
  }

  logger.warn('stopping server after startup failure', { reason, pid: currentServerProcess.pid ?? null });
  await killProcess(currentServerProcess, 'server', CHILD_SHUTDOWN_OPTIONS.server).catch((error) => {
    logger.warn('failed to stop server after startup failure', { reason, error: (error as Error).message });
  });
  if (serverProcess === currentServerProcess) {
    serverProcess = null;
  }
}

async function cleanupChildProcesses(isDevelopment: boolean): Promise<ChildShutdownResult[]> {
  const tasks: Array<Promise<ChildShutdownResult>> = [];

  const currentWebProcess = webProcess;
  webProcess = null;
  if (currentWebProcess) {
    tasks.push(killProcess(currentWebProcess, 'web', CHILD_SHUTDOWN_OPTIONS.web));
  }
  stationDiscovery?.stop();
  await Promise.all([...remoteGateways.values()].map(gateway => gateway.stop()
    .catch((error: unknown) => logger.warn('failed to stop remote gateway', error))));

  if (!isDevelopment) {
    const currentServerProcess = serverProcess;
    serverProcess = null;
    if (currentServerProcess) {
      await prepareEmbeddedServerShutdown('electron-cleanup');
      tasks.push(killProcess(currentServerProcess, 'server', CHILD_SHUTDOWN_OPTIONS.server));
    }
  }

  return Promise.all(tasks);
}

// 清理函数
async function cleanup(): Promise<ChildShutdownResult[]> {
  const isDevelopment = process.env.NODE_ENV === 'development' && !app.isPackaged;
  stopDevProcessMemoryLogger();
  startupLogSubscribers.clear();
  if (startupLogsInterval) {
    clearInterval(startupLogsInterval);
    startupLogsInterval = null;
  }
  const childResults = await cleanupChildProcesses(isDevelopment);

  selectedServerPort = null;
  selectedWebPort = null;
  selectedHttpsPort = null;
  internalShutdownToken = null;
  mainAppReadyForWindow = false;

  // 清理系统托盘
  if (trayInstance) {
    trayInstance.destroy();
    trayInstance = null;
  }

  logger.info('cleanup complete');
  return childResults;
}

/**
 * Starts the embedded station. With `present: false` it runs in the background
 * while another station owns the main window: startup errors are recorded for
 * the station manager instead of taking over the window.
 */
async function createWindow(options: { present?: boolean } = {}) {
  const present = options.present !== false;
  logger.info('createWindow called', { present });

  // 检查主窗口是否已存在且有效
  if (present && mainWindowInstance && !mainWindowInstance.isDestroyed()) {
    logger.info('main window already exists, reusing');
    mainWindowInstance.show();
    mainWindowInstance.focus();
    return mainWindowInstance;
  }

  // 清理已销毁的主窗口引用
  if (mainWindowInstance) {
    mainWindowInstance = null;
  }

  // 重置启动状态（支持重新启动场景）
  embeddedRuntimeStatus = 'starting';
  broadcastStationState();
  hasStartupError = false;
  errorType = '';
  startupErrorDialogShown = false;
  startupErrorState = null;

  const isDevelopment = process.env.NODE_ENV === 'development' && !app.isPackaged;
  const startupErrorMsgs = getMessages(app.getLocale()).startupErrors;
  logger.info(`isDevelopment: ${isDevelopment}`);

  const startupWindow = present ? await createMainWindowOnly({ target: EMBEDDED_TARGET }) : null;
  if (FORCE_STARTUP_ERROR_CARD_TEST) {
    logger.warn('forcing VC runtime startup error card for loading page test');
    showStartupError('vc_runtime', {
      detail: startupErrorMsgs.testHint,
      actions: ['open-vc-runtime-download'],
      errorType: 'VC_RUNTIME_TEST',
    });
    return startupWindow;
  }

  // Admin Token 将从 Server 生成的 .admin-token 文件中读取
  // 在 server 就绪后轮询获取

  if (isDevelopment) {
    const devWebPort = getDevWebPort();
    const devWebUrl = `http://localhost:${devWebPort}`;
    logger.info('development mode: using external dev services', {
      devWebUrl,
      serverReadyFile: getServerReadyPath(),
    });

    // 开发模式由 dev-runtime 启动 server；只信任 server ready 文件，避免误连到占用 4000 的其他服务。
    logger.info('waiting for backend server ready file...', {
      readyFile: getServerReadyPath(),
      timeoutMs: DEV_BACKEND_READY_TIMEOUT_MS,
    });
    let serverReady: ServerReadyState;
    try {
      serverReady = await waitForServerReady(DEV_BACKEND_READY_TIMEOUT_MS, 300);
    } catch (error) {
      logger.error('cannot confirm backend server readiness', error);
      showStartupError('server_timeout', {
        processName: 'server',
        detail: startupErrorMsgs.devBackendHint,
        error,
      });
      return;
    }

    if (!isValidPort(serverReady.httpPort)) {
      logger.error('backend server ready file did not include a valid port', serverReady);
      showStartupError('server_timeout', {
        processName: 'server',
        detail: startupErrorMsgs.devBackendHint,
      });
      return;
    }

    selectedServerPort = serverReady.httpPort;
    logger.info('backend server ready', {
      port: selectedServerPort,
      baseUrl: serverReady.baseUrl,
    });

    // 在开发模式下，等待前端 Vite 服务器准备就绪，再启动 Electron 专用 gateway。
    logger.info('waiting for frontend server...', {
      url: devWebUrl,
      timeoutMs: DEV_FRONTEND_READY_TIMEOUT_MS,
    });
    const webReady = await waitForHttp(devWebUrl, DEV_FRONTEND_READY_TIMEOUT_MS, 300);

    if (!webReady) {
      logger.error(`cannot connect to frontend server (${devWebUrl})`);
      showStartupError('web_timeout', {
        processName: 'client-tools',
        detail: startupErrorMsgs.devFrontendHint,
      });
      return;
    }

    logger.info('frontend server connected');

    try {
      selectedWebPort = await findFreePort(devWebPort + 1, DEFAULT_PORT_SCAN_STEPS, selectedServerPort, '0.0.0.0', { fallbackToRandom: false });
    } catch (error) {
      logger.error('development browser gateway port range exhausted', error);
      showStartupError('port_conflict', {
        processName: 'client-tools',
        error,
      });
      return;
    }

    const webEntry = webGatewayEntryPath();
    await ensureDesktopHttpsBeforeGatewayLaunch('development-startup');
    const webEnv = buildWebChildEnv(selectedServerPort);
    prepareWebGatewayLaunch(webEntry, webEnv);

    logger.info(`starting development browser gateway on port ${selectedWebPort}`);
    webProcess = runChild('client-tools', webEntry, webEnv);

    try {
      await waitAndApplyWebGatewayReady(webEnv, selectedWebPort);
      logger.info('development browser gateway ready');
    } catch (error) {
      if (webProcess) {
        await killProcess(webProcess, 'web');
        webProcess = null;
      }
      logger.error('development browser gateway startup timeout', error);
      showStartupError('web_timeout', {
        processName: 'client-tools',
        error,
      });
      return;
    }
  } else {
    // 生产模式：启动 server -> web，实时语音由 server 内置 rtc-data-audio 提供。
    logger.info('production mode: starting server and web child processes');
    const res = resourcesRoot();
    const serverEntry = join(res, 'app', 'packages', 'server', 'dist', 'index.js');
    const serverLauncherEntry = serverLauncherEntryPath();
    const webEntry = webGatewayEntryPath();

    const failedBackendPorts = new Set<number>();
    const backendLaunchFailures: BackendLaunchFailureSummary[] = [];
    let serverPort: number;
    try {
      serverPort = await selectBackendPort(failedBackendPorts);
    } catch (error) {
      logger.error('backend port negotiation exhausted', error);
      showStartupError('port_conflict', {
        processName: 'server',
        detail: error instanceof BackendPortExhaustedError
          ? `Backend port range ${error.startPort}-${error.endPort} is unavailable.\n${summarizePortDiagnostics(error.diagnostics)}`
          : undefined,
        error,
      });
      return;
    }
    let webPort: number;
    try {
      webPort = await findFreePort(DEFAULT_WEB_HTTP_PORT, DEFAULT_PORT_SCAN_STEPS, serverPort, '0.0.0.0', { fallbackToRandom: false });
    } catch (error) {
      logger.error('web gateway port range exhausted', error);
      showStartupError('port_conflict', {
        processName: 'client-tools',
        error,
      });
      return;
    }
    selectedServerPort = serverPort;
    selectedWebPort = webPort;

    logger.info(`ports selected: server=${serverPort}, web=${webPort}, rtcDataAudioUdp=${process.env.RTC_DATA_AUDIO_UDP_PORT || '50110'}`);

    logger.info('running native module check...');
    const nativeCheck = await runNativeModuleCheck(serverEntry);
    const loadedNativeModules = nativeCheck.modules.filter(mod => mod.ok).map(mod => mod.name);
    if (loadedNativeModules.length > 0) {
      logger.info(`native modules ok: ${loadedNativeModules.join(', ')}`);
    }
    for (const mod of nativeCheck.modules) {
      if (!mod.ok) {
        logger.error(`native module failed: ${mod.name} — ${mod.error}`);
      }
    }
    if (!nativeCheck.success) {
      const okModules = nativeCheck.modules.filter(m => m.ok).map(m => m.name);
      const failedModules = nativeCheck.modules.filter(m => !m.ok);
      const degradedRealtimeOnly = isDegradableNativeModuleCheckFailure(nativeCheck);

      if (degradedRealtimeOnly) {
        logger.warn('degradable realtime native check failed; continuing with PCM/ws fallback available', nativeCheck);
      } else {
        let detail: string;
        if (nativeCheck.crashedModule) {
          logger.error(`native module crashed the check process: ${nativeCheck.crashedModule} (exit=${nativeCheck.exitCode}, signal=${nativeCheck.signal})`);
          detail = `The following module crashed during loading:
  ${nativeCheck.crashedModule}`;
        } else if (nativeCheck.timeout) {
          logger.error('native module check timed out');
          detail = 'The native module check process timed out (30s).';
        } else {
          detail = `The following modules failed to load:
${failedModules.map(m => `  ${m.name}: ${m.error}`).join('\n')}`;
        }

        const okHint = okModules.length > 0
          ? `
Successfully loaded: ${okModules.join(', ')}`
          : '';
        const failHint = failedModules.length > 0
          ? `
Failed to load: ${failedModules.map(m => m.name).join(', ')}`
          : '';

        showStartupError('native_module', {
          processName: 'server',
          detail: `${detail}${okHint}${failHint}`,
          actions: process.platform === 'win32' ? ['open-vc-runtime-download'] : undefined,
        });
        return;
      }
    }
    logger.info('native module check complete');

    let serverReady: ServerReadyState | null = null;
    while (serverReady === null) {
      removeStaleServerReadyFile();
      const requestedServerPort = serverPort;
      const serverLaunchStartedAt = Date.now();
      internalShutdownToken = randomBytes(32).toString('hex');
      selectedServerPort = requestedServerPort;
      serverProcess = runChild('server', serverLauncherEntry, {
        PORT: String(requestedServerPort),
        WEB_PORT: String(webPort),
        ...(getDesktopHttpsConfig().enabled
          ? { TX5DR_DISCOVERY_HTTPS_PORT: String(getDesktopHttpsConfig().httpsPort || DEFAULT_WEB_HTTPS_PORT) }
          : {}),
        TX5DR_SERVER_ENTRY: serverEntry,
        TX5DR_INTERNAL_SHUTDOWN_TOKEN: internalShutdownToken,
        TX5DR_CONFIG_DIR: getAppConfigDir(),
        TX5DR_DATA_DIR: getAppDataDir(),
        TX5DR_LOGS_DIR: getAppLogsDir(),
        TX5DR_CACHE_DIR: getAppCacheDir(),
        TX5DR_SERVER_PORT_AUTO: '1',
        TX5DR_SERVER_PORT_SCAN_STEPS: String(DEFAULT_PORT_SCAN_STEPS),
        // The managed gateway remains the only browser-facing entrypoint.
        TX5DR_SERVER_HOST: '127.0.0.1',
        TX5DR_SERVER_READY_FILE: getServerReadyPath(),
        TX5DR_RUNTIME_MANAGEMENT: 'electron',
        RTC_DATA_AUDIO_UDP_PORT: process.env.RTC_DATA_AUDIO_UDP_PORT || '50110',
        RTC_DATA_AUDIO_ICE_UDP_MUX: process.env.RTC_DATA_AUDIO_ICE_UDP_MUX || '1',
      });

      logger.info('waiting for backend server ready file...', {
        readyFile: getServerReadyPath(),
        requestedPort: requestedServerPort,
      });

      try {
        serverReady = await awaitServerReadyWithCleanup({
          waitForServerReady: () => waitForServerReady(60_000, 200, serverLaunchStartedAt, {
            healthFailureTimeoutMs: BACKEND_HEALTH_FAILURE_RETRY_MS,
          }),
          getServerProcess: () => serverProcess,
          setServerProcess: (next) => {
            serverProcess = next;
          },
          killProcess: (processToStop, name) => killProcess(processToStop, name, CHILD_SHUTDOWN_OPTIONS.server),
        });
      } catch (error) {
        if (isRetryableBackendReadyError(error)) {
          const badPort = getReadyErrorPort(error) ?? requestedServerPort;
          failedBackendPorts.add(badPort);
          if (badPort !== requestedServerPort) {
            failedBackendPorts.add(requestedServerPort);
          }
          backendLaunchFailures.push({
            requestedPort: requestedServerPort,
            actualPort: badPort,
            reason: error instanceof ServerReadyHealthProbeError ? 'health probe failed' : (error.ready.error?.code ?? 'ready file error'),
            probe: error instanceof ServerReadyHealthProbeError ? summarizeProbeResult(error.probe) : null,
          });

          try {
            serverPort = await selectBackendPort(failedBackendPorts);
            logger.warn('backend launch retrying on next port', {
              failedPort: badPort,
              nextPort: serverPort,
              reason: error instanceof Error ? error.message : String(error),
            });
            continue;
          } catch (selectionError) {
            logger.error('backend port negotiation exhausted', selectionError);
            showStartupError('server_timeout', {
              processName: 'server',
              detail: buildBackendStartupTroubleshootingDetail(requestedServerPort, backendLaunchFailures, selectionError, startupErrorMsgs.realtimeFallbackHint),
              error: selectionError,
            });
            return;
          }
        }

        logger.error('backend server startup timeout', error);
        showStartupError('server_timeout', {
          processName: 'server',
          detail: buildBackendStartupTroubleshootingDetail(requestedServerPort, backendLaunchFailures, error, startupErrorMsgs.realtimeFallbackHint),
          error,
        });
        return;
      }
    }

    if (!isValidPort(serverReady.httpPort)) {
      logger.error('backend server ready file did not include a valid port', serverReady);
      await stopServerAfterStartupFailure('invalid-server-ready-file');
      showStartupError('server_timeout', {
        processName: 'server',
      });
      return;
    }

    selectedServerPort = serverReady.httpPort;
    logger.info('backend server ready', {
      requestedPort: serverReady.requestedPort ?? serverPort,
      actualPort: selectedServerPort,
      baseUrl: serverReady.baseUrl,
    });

    await ensureDesktopHttpsBeforeGatewayLaunch('production-startup');
    const webEnv = buildWebChildEnv(selectedServerPort);
    prepareWebGatewayLaunch(webEntry, webEnv);
    webProcess = runChild('client-tools', webEntry, webEnv);

    try {
      await waitAndApplyWebGatewayReady(webEnv, selectedWebPort);
    } catch (error) {
      if (webProcess) {
        await killProcess(webProcess, 'web');
        webProcess = null;
      }
      logger.error('web service startup timeout');
      showStartupError('web_timeout', {
        processName: 'client-tools',
        error,
      });
      return;
    }
    logger.info('web service ready');
  }

  // 最后检查：如果子进程已经崩溃
  if (hasStartupError) {
    logger.error('startup error detected', { errorType, crashedProcessName });
    if (startupErrorDialogShown) {
      return;
    }
    showStartupError('unknown', {
      processName: crashedProcessName || undefined,
      detail: errorType ? `Error type: ${errorType}` : null,
    });
    return;
  }

  if (fs.existsSync(path.join(getAppConfigDir(), '.admin-token'))) {
    logger.info('admin token file is ready');
  } else {
    logger.warn('admin token file not found, starting without authentication');
  }

  logger.info('services ready, loading main app');
  mainAppReadyForWindow = true;
  embeddedRuntimeStatus = 'ready';
  broadcastStationState();

  // Load the app into the embedded station window if one is open.
  const targetWindow = aliveWindow(mainWindowInstance as BrowserWindow | null);

  if (targetWindow) {
    await loadMainAppInWindow(targetWindow);
    return targetWindow;
  }

  logger.info('services ready but main window is closed; staying in background');
  return undefined;
}

// ===== Stations: embedded and remote =====
//
// Every station has at most one station window and they can be open side by
// side. The embedded station lives in the default session (`mainWindowInstance`);
// each remote station renders through its own loopback gateway in its own
// partition. A remote gateway runs while any window of that station is open.

type RemoteStationTarget = { kind: 'remote'; profile: RemoteStationProfile; origin: string; partition: string };
type StationWindowTarget = { kind: 'embedded' } | RemoteStationTarget;

const EMBEDDED_TARGET: StationWindowTarget = { kind: 'embedded' };

type EmbeddedRuntimeStatus = 'idle' | 'starting' | 'ready' | 'failed';
let embeddedRuntimeStatus: EmbeddedRuntimeStatus = 'idle';

type StationConnectErrorKind =
  | 'unreachable'
  | 'not-a-station'
  | 'bridge-too-old'
  | 'redirect'
  | 'gateway'
  | 'load'
  | 'certificate-changed';

interface StationConnectState {
  stationId: string;
  phase: 'probing' | 'gateway' | 'loading' | 'connected' | 'needs-trust' | 'failed';
  error?: { kind: StationConnectErrorKind; code?: string; location?: string; required?: number };
  certificate?: CertificateSummary;
  changed?: { expected: string; actual: string | null };
  notice?: 'portReassigned';
}

const remoteStationWindows = new Map<string, BrowserWindow>();
const stationConnectStates = new Map<string, StationConnectState>();
const stationConnectSequences = new Map<string, number>();
const remoteGateways = new Map<string, RemoteGatewaySupervisor>();
const remoteStationSessions = new Map<Electron.Session, { profileId: string; origin: string }>();
const configuredRemoteSessions = new WeakSet<Electron.Session>();
/** Station window the operator used last; target of system-wide shortcuts. */
let lastFocusedStationWindow: BrowserWindow | null = null;
let stationManagerWindow: BrowserWindow | null = null;
const stationStateSubscribers = new Map<number, WebContents>();
/** Detaches the lifecycle listeners a subscription installed on its page. */
const stationStateSubscriberCleanups = new Map<number, () => void>();

/**
 * The station manager is a page of the shell's own Web build: the packaged
 * `station-manager.html`, or the Vite dev server page in development. It never
 * comes from a station.
 */
function getStationManagerPageUrl(): string {
  if (isDevelopmentRuntime()) return `http://localhost:${getDevWebPort()}/station-manager.html`;
  return pathToFileURL(join(resourcesRoot(), 'app', 'packages', 'web', 'dist', 'station-manager.html')).href;
}

function loadStationManagerPage(windowInstance: BrowserWindow, query: Record<string, string>): Promise<void> {
  const url = getStationManagerPageUrl();
  if (url.startsWith('file:')) return windowInstance.loadFile(fileURLToPath(url), { query });
  return windowInstance.loadURL(`${url}?${new URLSearchParams(query).toString()}`);
}

function loadStationSettings(): StationSettings {
  return decodeStationSettings(loadElectronSettings().stations);
}

function saveStationSettings(next: StationSettings): void {
  if (!saveElectronSettings({ ...loadElectronSettings(), stations: next })) {
    throw new Error('station_settings_write_failed');
  }
  refreshStationMenus();
  broadcastStationState();
}

function remoteTarget(profile: RemoteStationProfile): RemoteStationTarget {
  return { kind: 'remote', profile, origin: gatewayOrigin(profile), partition: stationPartition(profile) };
}

function stationTargetById(stationId: string): StationWindowTarget | null {
  if (stationId === EMBEDDED_STATION_ID) return EMBEDDED_TARGET;
  const profile = findRemoteStation(loadStationSettings(), stationId);
  return profile ? remoteTarget(profile) : null;
}

/** Last station the operator opened or focused; opened first on the next launch. */
function getActiveStationTarget(): StationWindowTarget {
  return stationTargetById(loadStationSettings().activeStationId) ?? EMBEDDED_TARGET;
}

function stationIdOf(target: StationWindowTarget): string {
  return target.kind === 'embedded' ? EMBEDDED_STATION_ID : target.profile.id;
}

function stationOriginOf(target: StationWindowTarget): string {
  return target.kind === 'embedded' ? getWebUrl() : target.origin;
}

function aliveWindow(windowInstance: BrowserWindow | null | undefined): BrowserWindow | null {
  return windowInstance && !windowInstance.isDestroyed() ? windowInstance : null;
}

function getStationWindow(stationId: string): BrowserWindow | null {
  return stationId === EMBEDDED_STATION_ID
    ? aliveWindow(mainWindowInstance)
    : aliveWindow(remoteStationWindows.get(stationId));
}

function listStationWindows(): BrowserWindow[] {
  return [aliveWindow(mainWindowInstance), ...[...remoteStationWindows.values()].map(aliveWindow)]
    .filter((item): item is BrowserWindow => item !== null);
}

function hasOtherStationWindow(windowInstance: BrowserWindow): boolean {
  return listStationWindows().some(item => item !== windowInstance);
}

function getShortcutTargetWindow(): BrowserWindow | null {
  return aliveWindow(lastFocusedStationWindow) ?? listStationWindows()[0] ?? null;
}

function noteStationWindowFocused(windowInstance: BrowserWindow, stationId: string): void {
  lastFocusedStationWindow = windowInstance;
  const settings = loadStationSettings();
  if (settings.activeStationId !== stationId && stationTargetById(stationId)) {
    saveStationSettings({ ...settings, activeStationId: stationId });
  }
}

/** Station owning an IPC sender, for windows it opens; refuses unknown sessions. */
function requireSenderStation(event: Electron.IpcMainInvokeEvent): StationWindowTarget {
  if (event.sender.session === session.defaultSession) return EMBEDDED_TARGET;
  const binding = remoteStationSessions.get(event.sender.session);
  const profile = binding ? findRemoteStation(loadStationSettings(), binding.profileId) : null;
  if (!profile) throw new Error('station_not_found');
  return remoteTarget(profile);
}

function stationWebPreferences(target: StationWindowTarget, options: { pluginPage?: boolean } = {}): Electron.WebPreferences {
  if (target.kind === 'embedded') return embeddedStationWebPreferences(options);
  return remoteStationWebPreferences({
    preload: getPreloadPath(),
    partition: target.partition,
    bridgeArguments: buildBridgeArguments('remote', getShellPageUrls(), options),
  });
}

async function stationPageUrl(target: StationWindowTarget, pathAndQuery: string): Promise<string> {
  if (target.kind === 'embedded') return buildAuthenticatedRendererUrl(`${getWebUrl()}${pathAndQuery}`);
  return `${target.origin}${pathAndQuery}`;
}

/** Binds a remote partition to its gateway origin and installs its permission policy once. */
function configureRemoteStationSession(target: RemoteStationTarget): Electron.Session {
  const stationSession = session.fromPartition(target.partition);
  remoteStationSessions.set(stationSession, { profileId: target.profile.id, origin: target.origin });
  if (!configuredRemoteSessions.has(stationSession)) {
    configuredRemoteSessions.add(stationSession);
    stationSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const binding = remoteStationSessions.get(stationSession);
      const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      const allowed = Boolean(binding) && isRemoteStationPermissionAllowed(
        permission,
        details.requestingUrl ?? contents.getURL(),
        binding!.origin,
        mediaTypes,
      );
      if (!allowed) logger.warn('remote station permission denied', { permission, mediaTypes });
      callback(allowed);
    });
    stationSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      const binding = remoteStationSessions.get(stationSession);
      const mediaType = (details as { mediaType?: string }).mediaType;
      return Boolean(binding) && isRemoteStationPermissionAllowed(
        permission,
        requestingOrigin,
        binding!.origin,
        mediaType ? [mediaType] : [],
      );
    });
  }
  return stationSession;
}

function windowsInSession(stationSession: Electron.Session, except?: BrowserWindow): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(item =>
    item !== except && !item.isDestroyed() && item.webContents.session === stationSession);
}

/** Stops a remote station's gateway once none of its windows remain. */
function releaseRemoteStationIfUnused(stationSession: Electron.Session, closing: BrowserWindow): void {
  const binding = remoteStationSessions.get(stationSession);
  if (!binding || windowsInSession(stationSession, closing).length > 0) return;
  stationConnectSequences.set(binding.profileId, (stationConnectSequences.get(binding.profileId) ?? 0) + 1);
  stationConnectStates.delete(binding.profileId);
  const gateway = remoteGateways.get(binding.profileId);
  if (gateway) {
    logger.info('stopping remote gateway; no windows remain', { station: binding.profileId });
    void gateway.stop().catch(error => logger.warn('failed to stop remote gateway', error));
  }
  broadcastStationState();
}

/**
 * Keeps a remote station window on its gateway origin: other http(s) links open
 * in the system browser, popups and other schemes are refused. Closing the last
 * window of the station releases its gateway.
 */
function attachStationWindowGuards(windowInstance: BrowserWindow): void {
  const contents = windowInstance.webContents;
  const stationSession = contents.session;
  if (stationSession === session.defaultSession) return;
  const stationOrigin = (): string | null => remoteStationSessions.get(stationSession)?.origin ?? null;

  contents.on('will-navigate', (event, url) => {
    const origin = stationOrigin();
    const decision = origin ? classifyStationNavigation(url, origin) : 'deny';
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'external') void shell.openExternal(url);
    else logger.warn('remote station navigation blocked', { url: redactSensitiveUrl(url) });
  });
  contents.setWindowOpenHandler(({ url }) => {
    const origin = stationOrigin();
    if (origin && classifyStationNavigation(url, origin) === 'external') void shell.openExternal(url);
    return { action: 'deny' };
  });
  // 'closed' (not 'close'): a close can still be cancelled by the close-behavior prompt.
  windowInstance.on('closed', () => releaseRemoteStationIfUnused(stationSession, windowInstance));
}

function buildStationState(): DesktopStationsState {
  const settings = loadStationSettings();
  const embeddedError = embeddedRuntimeStatus === 'failed' && startupErrorState
    ? { title: startupErrorState.title, message: startupErrorState.message }
    : null;
  return {
    activeStationId: settings.activeStationId,
    openStationIds: [
      ...(getStationWindow(EMBEDDED_STATION_ID) ? [EMBEDDED_STATION_ID] : []),
      ...settings.profiles.filter(profile => getStationWindow(profile.id)).map(profile => profile.id),
    ],
    embedded: { id: EMBEDDED_STATION_ID, status: embeddedRuntimeStatus, error: embeddedError },
    profiles: settings.profiles.map(profile => ({
      id: profile.id,
      label: profile.label,
      url: profile.url,
      pinnedFingerprint256: profile.tls?.fingerprint256 ?? null,
      lastIdentity: profile.lastIdentity ?? null,
    })),
    connections: Object.fromEntries(stationConnectStates),
    discovered: (stationDiscovery?.list() ?? [])
      .filter(station => station.instanceId !== embeddedInstanceId)
      .map(station => ({
        instanceId: station.instanceId,
        label: station.label,
        url: station.url,
        hostVersion: station.hostVersion,
        profileId: settings.profiles.find(profile =>
          profile.lastIdentity?.instanceId === station.instanceId || profile.url === station.url)?.id ?? null,
      })),
  };
}

function broadcastStationState(): void {
  if (stationStateSubscribers.size === 0) return;
  const state = buildStationState();
  for (const [id, contents] of stationStateSubscribers) {
    if (contents.isDestroyed()) {
      stationStateSubscribers.delete(id);
      stationStateSubscriberCleanups.delete(id);
      continue;
    }
    contents.send('stations:state', state);
  }
}

function setStationConnectState(next: StationConnectState): void {
  stationConnectStates.set(next.stationId, next);
  broadcastStationState();
}

function describeProbeFailure(result: StationProbeResult): StationConnectState['error'] {
  switch (result.kind) {
    case 'unreachable': return { kind: 'unreachable', code: result.code };
    case 'not-a-station': return { kind: 'not-a-station', code: result.status === null ? undefined : String(result.status) };
    case 'bridge-too-old': return { kind: 'bridge-too-old', required: result.required };
    case 'redirect': return { kind: 'redirect', location: result.location };
    default: return { kind: 'unreachable', code: result.kind };
  }
}

function getRemoteGatewayEntryPath(): string {
  if (app.isPackaged) {
    return join(resourcesRoot(), 'app', 'packages', 'client-tools', 'src', 'remote-gateway.js');
  }
  return path.resolve(__dirname, '../../client-tools/src/remote-gateway.js');
}

function getRemoteGateway(stationId: string): RemoteGatewaySupervisor {
  let gateway = remoteGateways.get(stationId);
  if (!gateway) {
    gateway = new RemoteGatewaySupervisor({
      paths: {
        readyFile: path.join(getAppLogsDir(), 'remote-gateways', `${stationId}.ready.json`),
        logFile: path.join(getAppLogsDir(), 'remote-gateway.log'),
      },
      spawn: env => spawnRemoteGatewayChild(stationId, env),
      stop: async (child) => {
        await killProcess(child, 'remote-gateway', CHILD_SHUTDOWN_OPTIONS.web);
      },
    });
    remoteGateways.set(stationId, gateway);
  }
  return gateway;
}

/** Remote gateways are not part of embedded startup, so their exits never raise embedded errors. */
function spawnRemoteGatewayChild(stationId: string, env: Record<string, string>): import('node:child_process').ChildProcess {
  const entry = getRemoteGatewayEntryPath();
  logger.info(`[child:remote-gateway] starting station=${stationId} entry=${entry} port=${env.PORT}`);
  const child = spawn(nodePath(), [entry], {
    cwd: path.dirname(entry),
    env: createChildEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().trimEnd();
    if (lines) logger.debug(`[child:remote-gateway] ${lines}`);
  });
  child.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().trimEnd();
    if (lines) logger.warn(`[child:remote-gateway] ${lines}`);
  });
  child.on('error', error => logger.error('[child:remote-gateway] failed to start', error));
  child.on('exit', (code, signal) => {
    logger.info(`[child:remote-gateway] exited station=${stationId} pid=${child.pid ?? 'unknown'} code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    if (isQuitting || intentionalChildShutdowns.delete(child)) return;
    handleRemoteGatewayLost(stationId, code === null ? `signal ${signal}` : `code ${code}`);
  });
  return child;
}

function handleRemoteGatewayLost(stationId: string, reason: string): void {
  const state = stationConnectStates.get(stationId);
  if (!state || state.phase !== 'connected') return;
  logger.error('remote gateway exited unexpectedly', { station: stationId, reason });
  setStationConnectState({ stationId, phase: 'failed', error: { kind: 'gateway', code: 'GATEWAY_EXITED' } });
  showStationConnectPage(stationId);
}

function showStationConnectPage(stationId: string): void {
  const windowInstance = getStationWindow(stationId);
  if (!windowInstance || stationId === EMBEDDED_STATION_ID) return;
  void loadStationManagerPage(windowInstance, { mode: 'connect', station: stationId })
    .catch(error => logger.warn('failed to show station connect page', error));
}

function handleRemoteStationLoadFailure(
  windowInstance: BrowserWindow,
  target: RemoteStationTarget,
  errorCode: number,
  errorDescription: string,
  validatedURL: string,
): void {
  // -3 is ERR_ABORTED: a newer navigation replaced this one.
  if (errorCode === -3 || validatedURL.startsWith('file:')) return;
  logger.error('remote station page load failed', { station: target.profile.id, errorCode, errorDescription });
  if (getStationWindow(target.profile.id) !== windowInstance) return;
  setStationConnectState({ stationId: target.profile.id, phase: 'failed', error: { kind: 'load', code: errorDescription || String(errorCode) } });
  showStationConnectPage(target.profile.id);
}

function recordStationIdentity(profile: RemoteStationProfile, instanceId: string, hostVersion: string): RemoteStationProfile {
  const next: RemoteStationProfile = { ...profile, lastIdentity: { instanceId, hostVersion, seenAt: new Date().toISOString() } };
  const settings = loadStationSettings();
  if (findRemoteStation(settings, profile.id)) saveStationSettings(upsertRemoteStation(settings, next));
  return next;
}

/**
 * Probes the station, starts its gateway and loads its UI into its window.
 * A newer attempt for the same station or a closed window cancels the older one.
 */
async function connectRemoteStation(initialTarget: RemoteStationTarget, windowInstance: BrowserWindow): Promise<void> {
  const stationId = initialTarget.profile.id;
  const sequence = (stationConnectSequences.get(stationId) ?? 0) + 1;
  stationConnectSequences.set(stationId, sequence);
  const stale = () => stationConnectSequences.get(stationId) !== sequence || windowInstance.isDestroyed();
  const update = (state: Omit<StationConnectState, 'stationId'>) => {
    if (!stale()) setStationConnectState({ stationId, ...state });
  };

  let profile = initialTarget.profile;
  update({ phase: 'probing' });
  const probe = await probeStation(profile.url, { pinnedFingerprint256: profile.tls?.fingerprint256 ?? null });
  if (stale()) return;
  if (probe.kind === 'certificate-untrusted') {
    update({ phase: 'needs-trust', certificate: probe.certificate });
    return;
  }
  if (probe.kind === 'certificate-changed') {
    update({ phase: 'failed', error: { kind: 'certificate-changed' }, changed: { expected: probe.expected, actual: probe.actual } });
    return;
  }
  if (probe.kind !== 'ok') {
    logger.warn('remote station probe failed', { station: stationId, result: probe.kind });
    update({ phase: 'failed', error: describeProbeFailure(probe) });
    return;
  }
  profile = recordStationIdentity(profile, probe.identity.instanceId, probe.identity.hostVersion);

  update({ phase: 'gateway' });
  const gateway = getRemoteGateway(stationId);
  let notice: StationConnectState['notice'];
  try {
    await gateway.ensure(profile);
  } catch (error) {
    if (!(error instanceof RemoteGatewayStartError) || error.code !== 'EADDRINUSE') {
      logger.error('remote gateway failed to start', error);
      update({ phase: 'failed', error: { kind: 'gateway', code: (error as { code?: string }).code ?? 'GATEWAY_START_FAILED' } });
      return;
    }
    // The fixed port is taken by another program: move to a free one. The page origin
    // changes, so the station's sign-in on this computer has to be repeated.
    const settings = loadStationSettings();
    profile = { ...profile, gatewayPort: allocateGatewayPort(settings.profiles, () => true, new Set([profile.gatewayPort])) };
    saveStationSettings(upsertRemoteStation(settings, profile));
    notice = 'portReassigned';
    logger.warn('remote gateway port in use; reassigned', { station: stationId, port: profile.gatewayPort });
    try {
      await gateway.ensure(profile);
    } catch (retryError) {
      logger.error('remote gateway failed to start on reassigned port', retryError);
      update({ phase: 'failed', error: { kind: 'gateway', code: (retryError as { code?: string }).code ?? 'GATEWAY_START_FAILED' } });
      return;
    }
  }
  if (stale()) return;

  const target = remoteTarget(profile);
  configureRemoteStationSession(target);
  update({ phase: 'loading', notice });
  try {
    await windowInstance.loadURL(`${target.origin}/`);
  } catch (error) {
    // did-fail-load reports the failure and shows the connect page.
    logger.warn('remote station load rejected', { station: stationId, error: (error as Error).message });
    return;
  }
  update({ phase: 'connected', notice });
}

/**
 * Opens a station in its own window, or focuses the window it already has.
 * A remote station that is not connected is (re)connected in that window.
 */
async function openStation(stationId: string): Promise<void> {
  const target = stationTargetById(stationId);
  if (!target) throw new Error('station_not_found');
  const settings = loadStationSettings();
  if (settings.activeStationId !== stationId) saveStationSettings({ ...settings, activeStationId: stationId });

  const existing = getStationWindow(stationId);
  if (target.kind === 'embedded') {
    if (existing) {
      focusWindow(existing);
      return;
    }
    if (embeddedRuntimeStatus === 'idle') {
      await createWindow();
      return;
    }
    const windowInstance = await createMainWindowOnly({ target });
    if (embeddedRuntimeStatus === 'ready' && mainAppReadyForWindow) await loadMainAppInWindow(windowInstance);
    // While starting, createWindow loads the app when ready; after a failure the
    // loading page shows the recorded startup error.
    return;
  }

  if (existing && stationConnectStates.get(stationId)?.phase === 'connected') {
    focusWindow(existing);
    return;
  }
  logger.info('opening remote station', { station: stationId });
  const windowInstance = existing ?? await createMainWindowOnly({ target });
  if (existing) {
    focusWindow(existing);
    await loadStationManagerPage(existing, { mode: 'connect', station: stationId });
  }
  await connectRemoteStation(target, windowInstance);
}

function focusWindow(windowInstance: BrowserWindow): void {
  if (windowInstance.isMinimized()) windowInstance.restore();
  windowInstance.show();
  windowInstance.focus();
}

// ===== Local network discovery =====
// Browsing runs only while the station manager is open.

let stationDiscovery: StationDiscovery | null = null;
let embeddedInstanceId: string | null = null;

async function getEmbeddedInstanceId(): Promise<string | null> {
  if (embeddedInstanceId || !selectedServerPort) return embeddedInstanceId;
  const probe = await probeStation(`http://127.0.0.1:${selectedServerPort}`).catch(() => null);
  if (probe?.kind === 'ok') embeddedInstanceId = probe.identity.instanceId.toLowerCase();
  return embeddedInstanceId;
}

async function fetchStationProfileLabel(url: string): Promise<string | null> {
  try {
    const response = await nodeProbeTransport.get(url, '/api/station/info', { kind: 'system' });
    if (response.status !== 200) return null;
    const body = JSON.parse(response.body) as { data?: { callsign?: unknown; name?: unknown } };
    const callsign = typeof body.data?.callsign === 'string' ? body.data.callsign.trim() : '';
    const name = typeof body.data?.name === 'string' ? body.data.name.trim() : '';
    return [callsign, name].filter(Boolean).join(' · ') || null;
  } catch {
    return null;
  }
}

/** Lists a candidate only when the station at its address has the announced identity. */
async function describeDiscoveredStation(candidate: StationCandidate): Promise<CandidateDescription> {
  if (candidate.instanceId === await getEmbeddedInstanceId()) {
    logger.debug('ignoring the embedded station announcement', { url: candidate.url });
    return null;
  }
  const host = new URL(candidate.url).host;
  const probe = await probeStation(candidate.url);
  if (probe.kind === 'certificate-untrusted') return { label: host, hostVersion: null };
  if (probe.kind !== 'ok' || probe.identity.instanceId.toLowerCase() !== candidate.instanceId) {
    logger.debug('dropping unverified station announcement', {
      url: candidate.url,
      result: probe.kind,
      identityMatches: probe.kind === 'ok' ? false : null,
    });
    return null;
  }
  logger.debug('discovered station verified', { url: candidate.url, hostVersion: probe.identity.hostVersion });
  return { label: await fetchStationProfileLabel(candidate.url) ?? host, hostVersion: probe.identity.hostVersion };
}

function startStationDiscovery(): void {
  stationDiscovery ??= new StationDiscovery({
    browse: (onUp, onDown) => {
      const bonjour = new Bonjour(undefined, (error: unknown) => {
        logger.warn('local network discovery error', { error: error instanceof Error ? error.message : String(error) });
      });
      const browser = bonjour.find({ type: STATION_SERVICE_TYPE, protocol: 'tcp' });
      const snapshot = (service: { name: string; port: number; addresses?: string[]; txt?: unknown }) => ({
        name: service.name,
        port: service.port,
        addresses: service.addresses,
        txt: (service.txt ?? {}) as Record<string, unknown>,
      });
      browser.on('up', (service) => {
        logger.debug('station announcement received', { name: service.name, port: service.port });
        onUp(snapshot(service));
      });
      browser.on('srv-update', service => onUp(snapshot(service)));
      browser.on('down', service => onDown(snapshot(service)));
      return {
        stop: () => {
          browser.stop();
          bonjour.destroy();
        },
      };
    },
    describe: describeDiscoveredStation,
    onChange: broadcastStationState,
  });
  if (!stationDiscovery.running) {
    logger.info('browsing the local network for stations');
    stationDiscovery.start();
  }
}

async function openStationManagerWindow(): Promise<void> {
  if (stationManagerWindow && !stationManagerWindow.isDestroyed()) {
    focusWindow(stationManagerWindow);
    return;
  }
  const windowInstance = new BrowserWindow({
    width: 760,
    height: 700,
    minWidth: 560,
    minHeight: 480,
    show: true,
    title: 'TX-5DR',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111111' : '#f5f5f5',
    titleBarStyle: 'hiddenInset',
    frame: process.platform !== 'darwin',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: getPreloadPath(),
      additionalArguments: [buildShellPagesArgument(getShellPageUrls())],
    },
  });
  stationManagerWindow = windowInstance;
  if (process.platform === 'win32' || process.platform === 'linux') windowInstance.setMenuBarVisibility(false);
  windowInstance.webContents.on('will-navigate', event => event.preventDefault());
  windowInstance.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowInstance.on('closed', () => {
    if (stationManagerWindow === windowInstance) stationManagerWindow = null;
    stationDiscovery?.stop();
  });
  startStationDiscovery();
  await loadStationManagerPage(windowInstance, { mode: 'manage' });
  windowInstance.focus();
}

function buildStationMenuItems(): Electron.MenuItemConstructorOptions[] {
  const msgs = getMessages(app.getLocale());
  const settings = loadStationSettings();
  const open = (stationId: string) => () => {
    void openStation(stationId).catch(error => logger.error('failed to open station', error));
  };
  return [{
    label: msgs.menu.switchStation,
    submenu: [
      {
        label: msgs.menu.embeddedStation,
        type: 'checkbox',
        checked: Boolean(getStationWindow(EMBEDDED_STATION_ID)),
        click: open(EMBEDDED_STATION_ID),
      },
      ...settings.profiles.map((profile): Electron.MenuItemConstructorOptions => ({
        label: profile.label,
        type: 'checkbox',
        checked: Boolean(getStationWindow(profile.id)),
        click: open(profile.id),
      })),
      { type: 'separator' },
      { label: msgs.menu.manageStations, click: () => { void openStationManagerWindow(); } },
    ],
  }];
}

function refreshStationMenus(): void {
  if (!app.isReady()) return;
  if (trayInstance) trayInstance.setContextMenu(buildContextMenu(true));
  if (process.platform === 'darwin') {
    app.dock?.setMenu(buildContextMenu(false));
    createApplicationMenu();
  }
}

const StationSaveInputSchema = z.object({
  id: z.string().optional(),
  label: z.string().max(80),
  url: z.string().max(512),
  trustFingerprint256: z.string().nullable().optional(),
});

function normalizeFingerprintInput(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 64) throw new Error('invalid_fingerprint');
  return hex.match(/.{2}/g)!.join(':');
}

function saveStationFromInput(input: unknown): RemoteStationProfile {
  const parsed = StationSaveInputSchema.parse(input);
  const settings = loadStationSettings();
  const trusted = normalizeFingerprintInput(parsed.trustFingerprint256);
  const normalized = normalizeStationUrl(parsed.url);
  if (!normalized.ok) throw new Error(`invalid_station_url:${normalized.reason}`);
  const existing = parsed.id ? findRemoteStation(settings, parsed.id) : null;
  if (parsed.id && !existing) throw new Error('station_not_found');

  let profile: RemoteStationProfile;
  if (existing) {
    const urlChanged = existing.url !== normalized.url;
    profile = {
      ...existing,
      label: parsed.label.trim() || new URL(normalized.url).host,
      url: normalized.url,
      // A new address is a different station until proven otherwise.
      tls: urlChanged ? undefined : existing.tls,
      lastIdentity: urlChanged ? undefined : existing.lastIdentity,
    };
  } else {
    profile = createRemoteStationProfile({ label: parsed.label, url: normalized.url }, settings.profiles);
  }
  if (trusted && profile.url.startsWith('https:')) {
    profile = { ...profile, tls: { fingerprint256: trusted, pinnedAt: new Date().toISOString() } };
  }
  saveStationSettings(upsertRemoteStation(settings, profile));
  return profile;
}

async function removeStation(stationId: string): Promise<void> {
  const settings = loadStationSettings();
  const profile = findRemoteStation(settings, stationId);
  if (!profile) return;
  const stationSession = session.fromPartition(stationPartition(profile));
  for (const windowInstance of windowsInSession(stationSession)) windowInstance.destroy();
  await remoteGateways.get(stationId)?.stop();
  remoteGateways.delete(stationId);
  stationConnectStates.delete(stationId);
  remoteStationSessions.delete(stationSession);
  saveStationSettings(removeRemoteStation(settings, stationId));
  await stationSession.clearStorageData()
    .catch(error => logger.warn('failed to clear removed station storage', error));
}

async function trustStationCertificate(stationId: unknown, fingerprint: unknown): Promise<void> {
  if (typeof stationId !== 'string' || typeof fingerprint !== 'string') throw new Error('invalid_request');
  const state = stationConnectStates.get(stationId);
  const offered = state
    ? (state.phase === 'needs-trust' ? state.certificate?.fingerprint256 : state.changed?.actual) ?? null
    : null;
  const normalized = normalizeFingerprintInput(fingerprint);
  // Only the certificate the station just presented can be trusted.
  if (!offered || normalized !== offered) throw new Error('fingerprint_not_offered');
  const settings = loadStationSettings();
  const profile = findRemoteStation(settings, stationId);
  if (!profile) throw new Error('station_not_found');
  saveStationSettings(upsertRemoteStation(settings, {
    ...profile,
    tls: { fingerprint256: normalized, pinnedAt: new Date().toISOString() },
  }));
  await openStation(stationId);
}

// 启动应用
const startApp = async () => {
  await app.whenReady();

  logger.info('app ready');
  getDesktopUpdateService();

  // 初始化 electron-log：统一日志目录到与 server AppPaths 一致的位置
  const logsDir = getAppLogsDir();
  fs.mkdirSync(logsDir, { recursive: true });
  log.transports.file.resolvePathFn = () => path.join(logsDir, 'electron-main.log');
  // Keep production diagnostics detailed enough for startup/child-process issues.
  if (app.isPackaged) {
    log.transports.file.level = 'info';
    log.transports.console.level = 'info';
  }
  log.initialize();
  Object.assign(console, log.functions);
  log.errorHandler.startCatching();

  // 阻止 macOS App Nap 挂起进程（不阻止屏保，仅保证进程调度持续）
  powerSaveBlocker.start('prevent-app-suspension');

  // macOS: 确保应用有权限激活到前台
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
  }

  // 创建系统托盘（Windows/Linux）或 Dock 菜单（macOS）
  createTray();
  createDockMenu();
  createApplicationMenu();
  setupIpcHandlers();
  const startupSettings = loadElectronSettings();
  applyShortcutSettings(startupSettings.shortcuts, startupSettings.shortcutToggles);

  const activeStation = getActiveStationTarget();
  if (activeStation.kind === 'remote') {
    // The remote station is shown first; the embedded station starts in the background
    // and its failures never block the remote one.
    logger.info('active station is remote; starting embedded station in background', { station: activeStation.profile.id });
    const remoteWindow = await createMainWindowOnly({ target: activeStation });
    void connectRemoteStation(activeStation, remoteWindow);
    void (async () => {
      if (await ensureWindowsVCRuntimeInstalled({ present: false })) await createWindow({ present: false });
    })().catch(error => logger.error('background embedded station startup failed', error));
  } else {
    const vcRuntimeOk = await ensureWindowsVCRuntimeInstalled();
    if (!vcRuntimeOk) return;

    logger.info('calling createWindow');
    await createWindow();
    logger.info('createWindow complete');
  }
  startDevProcessMemoryLogger();

  if (app.isPackaged) {
    void getDesktopUpdateService().checkForUpdates().catch((error) => {
      logger.warn('initial desktop update check failed', error);
    });
  }
};

// 跟踪清理状态,防止重复清理
let isCleaningUp = false;
let hasCleanedUp = false;
let cleanupPromise: Promise<void> | null = null;
let lastQuitSource: QuitSource = 'unknown';
let relaunchAfterCleanup = false;
let isInstallingDesktopUpdate = false;


/**
 * Station whose session owns the sender: the default session holds the embedded
 * station, each remote station has its own partition bound to its gateway origin.
 */
function resolveBridgeStation(event: Electron.IpcMainInvokeEvent): BridgeStationBinding | null {
  if (event.sender.session === session.defaultSession) return { kind: 'embedded', origin: getWebUrl() };
  const binding = remoteStationSessions.get(event.sender.session);
  return binding ? { kind: 'remote', origin: binding.origin } : null;
}

function getShellPageUrls(): string[] {
  return [pathToFileURL(getLoadingPagePath()).href, getStationManagerPageUrl()];
}

/**
 * Registers an IPC handler behind the desktop bridge policy. The sender is
 * classified from its frame and session before the handler runs.
 */
function handleBridge<Args extends unknown[], Result>(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: Args) => Result,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const decision = evaluateBridgeCall(channel, {
      isMainFrame: Boolean(owner) && event.senderFrame === event.sender.mainFrame,
      frameUrl: event.senderFrame?.url ?? '',
      station: resolveBridgeStation(event),
      shellPageUrls: getShellPageUrls(),
    });
    if (!decision.allowed) {
      logger.warn('desktop bridge call denied', {
        channel,
        reason: decision.reason,
        url: redactSensitiveUrl(event.senderFrame?.url ?? ''),
      });
      throw new Error(`bridge_call_denied:${decision.reason}`);
    }
    return handler(event, ...(args as Args));
  });
}

function getDesktopUpdateService(): DesktopUpdateService {
  if (!desktopUpdateService) {
    desktopUpdateService = new DesktopUpdateService({
      getChannel: () => UpdatePreferencesSchema.parse({ channel: loadElectronSettings().updateChannel ?? BUILD_INFO.channel }).channel,
      saveChannel: channel => {
        if (!saveElectronSettings({ ...loadElectronSettings(), updateChannel: channel })) throw new Error('update_preferences_write_failed');
      },
      prepareInstall: prepareForDesktopUpdateInstall,
      beforeQuitAndInstall: markDesktopUpdateInstallHandoff,
      onQuitAndInstallError: resetDesktopUpdateInstallHandoff,
      onStatus: broadcastDesktopUpdateStatus,
    });
  }
  return desktopUpdateService;
}

function broadcastDesktopUpdateStatus(status: DesktopUpdateStatus): void {
  for (const windowInstance of BrowserWindow.getAllWindows()) {
    try {
      if (!windowInstance.isDestroyed()) {
        windowInstance.webContents.send('updater:status', status);
      }
    } catch (error) {
      logger.warn('failed to broadcast desktop update status', error);
    }
  }
}

function markDesktopUpdateInstallHandoff(): void {
  isInstallingDesktopUpdate = true;
}

function resetDesktopUpdateInstallHandoff(): void {
  isInstallingDesktopUpdate = false;
}

async function prepareForDesktopUpdateInstall(): Promise<void> {
  if (cleanupPromise) {
    await cleanupPromise;
    return;
  }

  lastQuitSource = 'renderer';
  cleanupPromise = (async () => {
    const totalStartedAt = Date.now();
    isQuitting = true;
    isCleaningUp = true;
    let visualCloseMs = 0;
    let cleanupSucceeded = false;

    try {
      if (serverProcess && !await prepareEmbeddedServerShutdown('desktop-update')) throw new Error('update_shutdown_not_safe');
      const childResults = await cleanup();
      if (childResults.some(result => result.forced)) throw new Error('update_shutdown_forced');
      const backupPath = await createUpdateBackup(
        [getAppConfigDir(), getAppDataDir()],
        path.join(path.dirname(getAppDataDir()), 'TX-5DR-update-backups'),
        BUILD_INFO,
        { sessionDataDir: app.getPath('sessionData') },
      );
      logger.info('Update backup completed', { backupPath });
      visualCloseMs = closeFrontendWindowsImmediately();
      hasCleanedUp = true;
      cleanupSucceeded = true;
      logger.info('cleanup done before desktop update install', {
        visualCloseMs,
        totalMs: Date.now() - totalStartedAt,
        childResults,
      });
    } catch (error) {
      hasCleanedUp = false;
      logger.error('cleanup failed before desktop update install', {
        visualCloseMs,
        totalMs: Date.now() - totalStartedAt,
        error,
      });
      throw error;
    } finally {
      isCleaningUp = false;
      if (cleanupSucceeded) {
        unregisterGlobalShortcuts();
      } else {
        isQuitting = false;
        isInstallingDesktopUpdate = false;
        cleanupPromise = null;
      }
    }
  })();

  await cleanupPromise;
}

// 统一的清理和退出处理函数
async function cleanupAndQuit(source: QuitSource = 'unknown', options?: { relaunch?: boolean }): Promise<void> {
  if (cleanupPromise) {
    return cleanupPromise;
  }

  lastQuitSource = source;
  relaunchAfterCleanup = options?.relaunch === true;
  cleanupPromise = (async () => {
    const totalStartedAt = Date.now();

    isQuitting = true;
    isCleaningUp = true;

    const visualCloseMs = closeFrontendWindowsImmediately();

    try {
      const childResults = await cleanup();
      hasCleanedUp = true;
      logger.info('cleanup done, exiting app', {
        source: lastQuitSource,
        visualCloseMs,
        totalMs: Date.now() - totalStartedAt,
        childResults,
      });
    } catch (error) {
      hasCleanedUp = true;
      logger.error('cleanup failed', {
        source: lastQuitSource,
        visualCloseMs,
        totalMs: Date.now() - totalStartedAt,
        error,
      });
    } finally {
      isCleaningUp = false;
      unregisterGlobalShortcuts();
      if (relaunchAfterCleanup) {
        app.relaunch();
      }
      app.exit(0);
    }
  })();

  return cleanupPromise;
}

// 应用退出事件处理
app.on('will-quit', (event) => {
  logger.info('app will-quit');

  if (isInstallingDesktopUpdate) {
    return;
  }

  if (!hasCleanedUp) {
    event.preventDefault();
    if (!isCleaningUp) {
      void cleanupAndQuit('will-quit');
    }
  }
});

app.on('before-quit', (event) => {
  logger.info('app before-quit');

  if (isInstallingDesktopUpdate) {
    return;
  }

  if (!hasCleanedUp) {
    event.preventDefault();
    if (!isCleaningUp) {
      void cleanupAndQuit('before-quit');
    }
  }
});

app.on('window-all-closed', () => {
  logger.info('all windows closed');
  // 所有平台都不在此退出，通过托盘/Dock菜单的"退出"来真正退出
  // Windows/Linux 有托盘常驻，macOS 有 Dock 常驻
});

app.on('activate', () => {
  // macOS: 当点击dock图标时，恢复或创建主窗口
  showMainWindow();
});

// 处理进程退出信号
process.on('SIGINT', () => {
  logger.info('received SIGINT');
  void cleanupAndQuit('unknown');
});

process.on('SIGTERM', () => {
  logger.info('received SIGTERM');
  void cleanupAndQuit('unknown');
});

function sanitizeDialogTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 120) : undefined;
}

function sanitizeFileDialogFilters(value: unknown): Electron.FileFilter[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const filters: Electron.FileFilter[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string' || !Array.isArray(record.extensions)) continue;

    const extensions = record.extensions
      .filter((extension): extension is string => typeof extension === 'string')
      .map(extension => extension.trim().replace(/^\./, '').toLowerCase())
      .filter(extension => /^[a-z0-9*]+$/i.test(extension))
      .slice(0, 20);

    if (extensions.length === 0) continue;
    filters.push({
      name: record.name.trim().slice(0, 80) || 'Files',
      extensions,
    });
  }

  return filters.length > 0 ? filters.slice(0, 10) : undefined;
}

function getDialogParentWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | undefined {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow && !senderWindow.isDestroyed()) {
    return senderWindow;
  }
  if (mainWindowInstance && !mainWindowInstance.isDestroyed()) {
    return mainWindowInstance;
  }
  return undefined;
}

function showOpenDialogForEvent(
  event: Electron.IpcMainInvokeEvent,
  options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
  const parentWindow = getDialogParentWindow(event);
  if (parentWindow) {
    return dialog.showOpenDialog(parentWindow, options);
  }
  return dialog.showOpenDialog(options);
}

function showSaveDialogForEvent(
  event: Electron.IpcMainInvokeEvent,
  options: Electron.SaveDialogOptions,
): Promise<Electron.SaveDialogReturnValue> {
  const parentWindow = getDialogParentWindow(event);
  if (parentWindow) {
    return dialog.showSaveDialog(parentWindow, options);
  }
  return dialog.showSaveDialog(options);
}

/**
 * 设置IPC处理器
 */
function setupIpcHandlers() {
  if (ipcHandlersConfigured) {
    logger.debug('IPC handlers already configured, skipping');
    return;
  }
  ipcHandlersConfigured = true;

  // 处理打开"关于"窗口的请求
  handleBridge('window:openAbout', async (event) => {
    logger.info('IPC window:openAbout');
    await openAboutWindow(requireSenderStation(event));
  });

  // 处理打开通联日志窗口的请求
  handleBridge('window:openLogbook', async (event, queryString: string) => {
    logger.info(`IPC window:openLogbook, queryString: ${queryString}`);
    const target = requireSenderStation(event);

    try {
      // 创建新的通联日志窗口
      const logbookWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: true,
        titleBarStyle: 'hiddenInset',
        titleBarOverlay: process.platform === 'win32' ? {
          color: '#ffffff',
          symbolColor: '#000000'
        } : false,
        frame: process.platform !== 'darwin',
        webPreferences: stationWebPreferences(target),
      });
      attachStationWindowGuards(logbookWindow);

      // 在 Windows 和 Linux 下隐藏菜单栏
      if (process.platform === 'win32' || process.platform === 'linux') {
        logbookWindow.setMenuBarVisibility(false);
      }

      // 加载通联日志页面
      const logbookUrl = await stationPageUrl(target, `/logbook.html?${queryString}`);
      if (process.env.NODE_ENV === 'development' && !app.isPackaged) {
        // 开发模式：使用 Vite
        logger.info(`IPC window:openLogbook loading dev URL: ${redactSensitiveText(logbookUrl)}`);
        await logbookWindow.loadURL(logbookUrl);
        if (shouldOpenDevTools()) {
          logbookWindow.webContents.openDevTools();
        }
      } else {
        // 生产模式：连接内置静态 web 服务
        logger.info(`IPC window:openLogbook loading prod URL: ${redactSensitiveText(logbookUrl)}`);
        await logbookWindow.loadURL(logbookUrl);
      }

      // 聚焦新窗口
      logbookWindow.focus();

      logger.info('IPC window:openLogbook window created');
    } catch (error) {
      logger.error('IPC window:openLogbook failed to create window', error);
      throw error;
    }
  });

  handleBridge('window:openPluginPage', async (event, queryString: string) => {
    const target = requireSenderStation(event);
    const params = new URLSearchParams(queryString);
    const pluginName = params.get('pluginName')?.trim();
    const pageId = params.get('pageId')?.trim();
    if (!pluginName || !pageId) {
      throw new Error('pluginName and pageId are required');
    }

    logger.info(`IPC window:openPluginPage, plugin=${pluginName}, page=${pageId}`);
    try {
      const pluginPageWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 640,
        minHeight: 480,
        show: true,
        titleBarStyle: 'hiddenInset',
        titleBarOverlay: process.platform === 'win32' ? {
          color: '#ffffff',
          symbolColor: '#000000',
        } : false,
        frame: process.platform !== 'darwin',
        webPreferences: stationWebPreferences(target, { pluginPage: true }),
      });
      attachStationWindowGuards(pluginPageWindow);

      if (process.platform === 'win32' || process.platform === 'linux') {
        pluginPageWindow.setMenuBarVisibility(false);
      }

      const pluginPageUrl = await stationPageUrl(target, `/plugin-page.html?${params.toString()}`);
      logger.info(`IPC window:openPluginPage loading URL: ${redactSensitiveText(pluginPageUrl)}`);
      await pluginPageWindow.loadURL(pluginPageUrl);
      if (process.env.NODE_ENV === 'development' && !app.isPackaged && shouldOpenDevTools()) {
        pluginPageWindow.webContents.openDevTools();
      }
      pluginPageWindow.focus();
    } catch (error) {
      logger.error('IPC window:openPluginPage failed to create window', error);
      throw error;
    }
  });

  // 处理打开独立频谱图窗口的请求
  handleBridge('window:openSpectrumWindow', async (event) => {
    logger.info('IPC window:openSpectrumWindow');
    const target = requireSenderStation(event);

    try {
      const spectrumWindow = new BrowserWindow({
        width: 1200,
        height: 500,
        minWidth: 600,
        minHeight: 200,
        show: true,
        titleBarStyle: 'hiddenInset',
        titleBarOverlay: process.platform === 'win32' ? {
          color: '#ffffff',
          symbolColor: '#000000'
        } : false,
        frame: process.platform !== 'darwin',
        webPreferences: stationWebPreferences(target),
      });
      attachStationWindowGuards(spectrumWindow);

      // 在 Windows 和 Linux 下隐藏菜单栏
      if (process.platform === 'win32' || process.platform === 'linux') {
        spectrumWindow.setMenuBarVisibility(false);
      }

      // 加载频谱图页面
      const spectrumUrl = await stationPageUrl(target, '/spectrum.html');
      if (process.env.NODE_ENV === 'development' && !app.isPackaged) {
        logger.info(`IPC window:openSpectrumWindow loading dev URL: ${redactSensitiveText(spectrumUrl)}`);
        await spectrumWindow.loadURL(spectrumUrl);
        if (shouldOpenDevTools()) {
          spectrumWindow.webContents.openDevTools();
        }
      } else {
        logger.info(`IPC window:openSpectrumWindow loading prod URL: ${redactSensitiveText(spectrumUrl)}`);
        await spectrumWindow.loadURL(spectrumUrl);
      }

      // 聚焦新窗口
      spectrumWindow.focus();

      // 窗口关闭时通知主窗口，以便主窗口恢复显示频谱图
      // Tell the window that popped the spectrum out, which may belong to any station.
      const opener = event.sender;
      spectrumWindow.on('closed', () => {
        if (!opener.isDestroyed()) opener.send('spectrum-window-closed');
      });

      logger.info('IPC window:openSpectrumWindow window created');
    } catch (error) {
      logger.error('IPC window:openSpectrumWindow failed to create window', error);
      throw error;
    }
  });

  // Open an app-owned directory (logs, data, plugins, diagnostics) in the file manager.
  handleBridge('shell:openPath', async (_event, requestedPath: unknown) => {
    const decision = await resolveOpenableAppPath(requestedPath, {
      roots: [getAppConfigDir(), getAppDataDir(), getAppLogsDir(), getAppCacheDir()],
    });
    if (!decision.allowed) {
      logger.warn('IPC shell:openPath denied', { reason: decision.reason });
      throw new Error(`open_path_denied:${decision.reason}`);
    }
    logger.info(`IPC shell:openPath: ${decision.path}`);

    try {
      if (!decision.exists) await fs.promises.mkdir(decision.path, { recursive: true });
      const result = await shell.openPath(decision.path);
      if (result) {
        logger.error(`IPC shell:openPath failed: ${result}`);
        throw new Error(result);
      }
      logger.info('IPC shell:openPath success');
      return result;
    } catch (error) {
      logger.error('IPC shell:openPath failed', error);
      throw error;
    }
  });

  // 处理打开外部链接的请求
  handleBridge('shell:openExternal', async (_event, url: string) => {
    logger.info(`IPC shell:openExternal: ${url}`);

    try {
      // 验证URL格式
      const urlObj = new URL(url);

      // 只允许http和https协议
      if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
        throw new Error(`unsafe protocol: ${urlObj.protocol}`);
      }

      // 使用系统默认浏览器打开链接
      await shell.openExternal(url);
      logger.info('IPC shell:openExternal success');
    } catch (error) {
      logger.error('IPC shell:openExternal failed', error);
      throw error;
    }
  });

  handleBridge('fs:selectFile', async (event, options?: FsSelectFileOptions) => {
    logger.info('IPC fs:selectFile');
    const result = await showOpenDialogForEvent(event, {
      title: sanitizeDialogTitle(options?.title),
      filters: sanitizeFileDialogFilters(options?.filters),
      properties: ['openFile'],
    });

    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handleBridge('fs:selectDirectory', async (event, options?: FsSelectDirectoryOptions) => {
    logger.info('IPC fs:selectDirectory');
    const result = await showOpenDialogForEvent(event, {
      title: sanitizeDialogTitle(options?.title),
      properties: ['openDirectory', 'createDirectory'],
    });

    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handleBridge('fs:saveFile', async (event, options?: FsSaveFileOptions) => {
    const data = copyRendererFileBytes(options?.data);
    const defaultName = sanitizeRendererSaveFileName(options?.defaultName);
    logger.info(`IPC fs:saveFile requested, bytes=${data.byteLength}`);
    const result = await showSaveDialogForEvent(event, {
      title: sanitizeDialogTitle(options?.title),
      defaultPath: join(app.getPath('downloads'), defaultName),
      filters: sanitizeFileDialogFilters(options?.filters),
    });
    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }
    await fs.promises.writeFile(result.filePath, data);
    logger.info('IPC fs:saveFile success');
    return { canceled: false, filePath: result.filePath };
  });

  handleBridge('app:getVersion', () => BUILD_INFO.version);
  handleBridge('app:getBuildInfo', () => BUILD_INFO);
  handleBridge('app:quit', async () => {
    await cleanupAndQuit('renderer');
  });
  handleBridge('app:restart', async () => {
    await cleanupAndQuit('renderer', { relaunch: true });
  });

  handleBridge('startupLogs:subscribe', (event) => {
    ensureStartupLogsPolling();
    const webContentsId = event.sender.id;
    startupLogSubscribers.set(webContentsId, event.sender);
    const cleanupSubscriber = () => removeStartupLogSubscriber(webContentsId);
    event.sender.once('destroyed', cleanupSubscriber);
    event.sender.once('did-navigate', cleanupSubscriber);
    return createStartupLogsPayload(true);
  });

  handleBridge('startupLogs:unsubscribe', (event) => {
    removeStartupLogSubscriber(event.sender.id);
  });

  handleBridge('startupLogs:openFolder', async () => {
    const logsDir = getAppLogsDir();
    logger.info(`IPC startupLogs:openFolder: ${logsDir}`);

    try {
      fs.mkdirSync(logsDir, { recursive: true });
      const result = await shell.openPath(logsDir);
      if (result) {
        logger.error(`IPC startupLogs:openFolder failed: ${result}`);
        throw new Error(result);
      }
      logger.info('IPC startupLogs:openFolder success');
    } catch (error) {
      logger.error('IPC startupLogs:openFolder failed', error);
      throw error;
    }
  });

  handleBridge('startupLogs:runAction', async (_event, actionId: StartupErrorActionId) => {
    logger.info(`IPC startupLogs:runAction: ${actionId}`);

    if (actionId === 'open-station-manager') {
      await openStationManagerWindow();
      return;
    }
    if (actionId !== 'open-vc-runtime-download') {
      throw new Error(`unsupported startup action: ${String(actionId)}`);
    }

    try {
      await shell.openExternal(VC_REDIST_X64_URL);
      logger.info('IPC startupLogs:runAction open-vc-runtime-download success');
    } catch (error) {
      logger.error('IPC startupLogs:runAction failed', error);
      throw error;
    }
  });

  handleBridge('updater:getStatus', () => {
    return getDesktopUpdateService().getStatus();
  });

  handleBridge('updater:setChannel', async (event, request: unknown) => {
    return getDesktopUpdateService().setChannel(request);
  });

  handleBridge('updater:check', async () => {
    return getDesktopUpdateService().checkForUpdates();
  });

  handleBridge('updater:openDownload', async (_event, url?: string) => {
    await getDesktopUpdateService().openDownload(url);
  });

  handleBridge('updater:download', async (event, request: unknown) => {
    return getDesktopUpdateService().download(request);
  });

  handleBridge('updater:installAndRestart', async (event, request: unknown) => {
    return getDesktopUpdateService().installAndRestart(request);
  });

  handleBridge('https:getStatus', async () => {
    return getDesktopHttpsStatus();
  });

  handleBridge('https:getShareUrls', async () => {
    const status = await getDesktopHttpsStatus();
    return status.shareUrls;
  });

  handleBridge('https:generateSelfSigned', async () => {
    const settings = loadElectronSettings();
    const nextConfig = await generateSelfSignedCertificate({
      configDir: getAppConfigDir(),
      hostname: getHostname(),
      lanAddresses: getLanIpv4Addresses(),
      existingConfig: settings.desktopHttps,
    });
    return persistDesktopHttpsConfig(nextConfig);
  });

  handleBridge('https:importPemCertificate', async (_event, certPath: string, keyPath: string) => {
    if (!certPath || !keyPath) {
      throw new Error('certificate_paths_required');
    }

    const settings = loadElectronSettings();
    const nextConfig = await importPemCertificate({
      configDir: getAppConfigDir(),
      certPath,
      keyPath,
      existingConfig: settings.desktopHttps,
    });
    return persistDesktopHttpsConfig(nextConfig);
  });

  handleBridge('https:applySettings', async (
    _event,
    update: Partial<Pick<PersistentDesktopHttpsConfig, 'enabled' | 'mode' | 'httpsPort' | 'redirectExternalHttp'>>,
  ) => {
    return applyDesktopHttpsSettings({
      enabled: update.enabled,
      mode: update.mode,
      httpsPort: update.httpsPort,
      redirectExternalHttp: update.redirectExternalHttp,
    });
  });

  handleBridge('https:disable', async () => {
    const settings = loadElectronSettings();
    const nextConfig = await disableDesktopHttps(settings.desktopHttps);
    return persistDesktopHttpsConfig(nextConfig);
  });

  handleBridge('remoteAccess:getPreset', () => {
    return loadElectronSettings().remoteAccessPreset ?? 'local';
  });

  handleBridge('remoteAccess:applyPreset', async (_event, preset: 'local' | 'lan' | 'public') => {
    if (!['local', 'lan', 'public'].includes(preset)) throw new Error('invalid_remote_access_preset');
    const previous = loadElectronSettings();
    const next: ElectronSettings = {
      ...previous,
      remoteAccessPreset: preset,
      desktopHttps: sanitizeDesktopHttpsConfig({
        ...previous.desktopHttps,
        enabled: preset !== 'local',
        mode: preset === 'public' && previous.desktopHttps?.mode === 'imported-pem' ? 'imported-pem' : 'self-signed',
        redirectExternalHttp: preset !== 'local',
      }),
    };
    saveElectronSettings(next);
    try {
      if (preset !== 'local' && next.desktopHttps?.mode === 'self-signed') {
        const ensured = await ensureDefaultSelfSignedCertificate({
          configDir: getAppConfigDir(),
          hostname: getHostname(),
          lanAddresses: getLanIpv4Addresses(),
          existingConfig: next.desktopHttps,
        });
        saveElectronSettings({ ...next, desktopHttps: ensured.config });
      }
      if (webProcess && selectedServerPort && selectedWebPort) await restartWebGateway();
      return { preset, https: await getDesktopHttpsStatus() };
    } catch (error) {
      saveElectronSettings(previous);
      if (webProcess && selectedServerPort && selectedWebPort) {
        try { await restartWebGateway(); } catch (rollbackError) { logger.error('remote access rollback failed', rollbackError); }
      }
      throw error;
    }
  });

  handleBridge('shortcuts:getConfig', () => {
    return loadElectronSettings().shortcuts ?? createDefaultShortcutConfig();
  });

  handleBridge('shortcuts:getToggles', () => {
    return getShortcutToggles();
  });

  handleBridge('shortcuts:setToggles', (_event, toggles: unknown) => {
    const settings = loadElectronSettings();
    const shortcutToggles = normalizeShortcutToggles(toggles);
    if (!saveElectronSettings({ ...settings, shortcutToggles })) {
      throw new Error('failed_to_persist_shortcut_toggles');
    }
    return applyShortcutSettings(settings.shortcuts, shortcutToggles);
  });

  handleBridge('shortcuts:setConfig', (_event, config: unknown) => {
    const settings = loadElectronSettings();
    const shortcuts = normalizeShortcutConfig(config);
    if (!saveElectronSettings({ ...settings, shortcuts })) {
      throw new Error('failed_to_persist_shortcut_config');
    }
    return applyShortcutSettings(shortcuts, settings.shortcutToggles);
  });

  handleBridge('shortcuts:register', (_event, config?: unknown) => {
    const settings = loadElectronSettings();
    if (config === undefined) {
      return applyShortcutSettings(settings.shortcuts, settings.shortcutToggles);
    }

    const shortcuts = normalizeShortcutConfig(config);
    if (!saveElectronSettings({ ...settings, shortcuts })) {
      throw new Error('failed_to_persist_shortcut_config');
    }
    return applyShortcutSettings(shortcuts, settings.shortcutToggles);
  });

  handleBridge('shortcuts:startRecording', (event, actionId: unknown) => {
    if (!isShortcutActionId(actionId)) {
      throw new Error('invalid_shortcut_action');
    }

    unregisterGlobalShortcuts();
    shortcutRecordingWebContentsId = event.sender.id;
    shortcutRecordingActionId = actionId;
  });

  handleBridge('shortcuts:stopRecording', (event) => {
    if (shortcutRecordingWebContentsId === event.sender.id) {
      stopShortcutRecording({ restoreGlobalShortcuts: true });
    }
  });

  handleBridge('voicePttShortcut:setConfig', (event, payload: VoicePttShortcutConfigPayload) => {
    return updateVoicePttShortcutCapture(event.sender.id, payload ?? {});
  });

  handleBridge('stations:openManager', async () => {
    await openStationManagerWindow();
  });

  handleBridge('stations:getCurrent', (event): DesktopCurrentStation => {
    const target = requireSenderStation(event);
    return target.kind === 'embedded'
      ? { stationId: EMBEDDED_STATION_ID, kind: 'embedded', label: null, url: null }
      : { stationId: target.profile.id, kind: 'remote', label: target.profile.label, url: target.profile.url };
  });

  handleBridge('stations:getState', () => buildStationState());

  handleBridge('stations:subscribe', (event) => {
    const contents = event.sender;
    // Re-subscribing the same page only refreshes its snapshot; listeners are attached once.
    if (!stationStateSubscribers.has(contents.id)) {
      stationStateSubscribers.set(contents.id, contents);
      const remove = () => {
        stationStateSubscribers.delete(contents.id);
        stationStateSubscriberCleanups.delete(contents.id);
        contents.off('did-navigate', remove);
        contents.off('destroyed', remove);
      };
      stationStateSubscriberCleanups.set(contents.id, remove);
      contents.once('destroyed', remove);
      contents.once('did-navigate', remove);
    }
    return buildStationState();
  });

  handleBridge('stations:unsubscribe', (event) => {
    const remove = stationStateSubscriberCleanups.get(event.sender.id);
    if (remove) remove();
    else stationStateSubscribers.delete(event.sender.id);
  });

  handleBridge('stations:probe', async (_event, url: unknown) => {
    const normalized = normalizeStationUrl(typeof url === 'string' ? url : '');
    if (!normalized.ok) return { kind: 'invalid-url', reason: normalized.reason };
    return { url: normalized.url, ...(await probeStation(normalized.url)) };
  });

  handleBridge('stations:save', (_event, input: unknown) => {
    const profile = saveStationFromInput(input);
    return { id: profile.id };
  });

  handleBridge('stations:remove', async (_event, stationId: unknown) => {
    if (typeof stationId !== 'string') throw new Error('invalid_request');
    await removeStation(stationId);
  });

  handleBridge('stations:connect', async (_event, stationId: unknown) => {
    if (typeof stationId !== 'string') throw new Error('invalid_request');
    await openStation(stationId);
  });

  handleBridge('stations:trustCertificate', async (_event, stationId: unknown, fingerprint: unknown) => {
    await trustStationCertificate(stationId, fingerprint);
  });

  // Station pages may only read and write the whitelisted shell settings.
  handleBridge('config:get', (_event, key: unknown) => {
    if (!isBridgeConfigKey(key)) throw new Error('config_key_not_allowed');
    const settings = loadElectronSettings() as unknown as Record<string, unknown>;
    return settings[key] ?? null;
  });

  handleBridge('config:set', (_event, key: unknown, value: unknown) => {
    if (!isBridgeConfigKey(key)) throw new Error('config_key_not_allowed');
    if (!isValidBridgeConfigValue(key, value)) throw new Error('config_value_invalid');
    const settings = loadElectronSettings();
    (settings as unknown as Record<string, unknown>)[key] = value;
    if (!saveElectronSettings(settings)) throw new Error('config_write_failed');
  });

  handleBridge('config:getAll', () => {
    const settings = loadElectronSettings() as unknown as Record<string, unknown>;
    return Object.fromEntries(listBridgeConfigKeys().map(key => [key, settings[key] ?? null]));
  });
}

// ===== 单实例锁（仅生产模式，开发模式下跳过以便于调试重启） =====
const isDevMode = process.env.NODE_ENV === 'development' && !app.isPackaged;
const disableSingleInstanceLock = process.env.TX5DR_DISABLE_SINGLE_INSTANCE_LOCK === '1';
let shouldStart = true;

if (!isDevMode && !disableSingleInstanceLock) {
  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    logger.info('another instance is already running, quitting');
    shouldStart = false;
    app.quit();
  } else {
    app.on('second-instance', () => {
      logger.info('second instance detected, focusing existing window');
      showMainWindow();
    });
  }
} else if (disableSingleInstanceLock) {
  logger.info('single instance lock disabled by TX5DR_DISABLE_SINGLE_INSTANCE_LOCK');
}

if (shouldStart) {
  logger.info('app startup');
  startApp().catch((err) => logger.error('startApp failed', err));
}
