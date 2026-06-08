import { app, BrowserWindow, ipcMain, shell, Tray, Menu, dialog, nativeTheme, powerSaveBlocker, session, globalShortcut, type WebContents } from 'electron';
import log from 'electron-log/main';
import { homedir, hostname as getHostname, networkInterfaces } from 'node:os';
import net from 'node:net';
import { join } from 'path';
import http from 'http';
import https from 'https';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { DesktopHttpsStatus } from '@tx5dr/contracts';
import { DesktopUpdateService, type DesktopUpdateStatus } from './desktopUpdate.js';
import { BUILD_INFO } from './generated/buildInfo.js';
import { createLogger } from './utils/logger.js';
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

// 获取当前模块的目录(ESM中的__dirname替代方案)
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = dirname(__filename);

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

const voicePttShortcutCapture: VoicePttShortcutCaptureState = {
  enabled: false,
  preset: 'Backquote',
  webContentsId: null,
  keyDownActive: false,
  lastKeyDownAt: null,
};

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
type StartupErrorActionId = 'open-vc-runtime-download';

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

interface CreateMainWindowOptions {
  startHealthCheck?: boolean;
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
const STARTUP_LOG_POLL_INTERVAL_MS = 200;
const STARTUP_LOG_TAIL_BYTES = 96 * 1024;
const STARTUP_LOG_MAX_READ_BYTES = 256 * 1024;
const startupLogSubscribers = new Map<number, WebContents>();
let startupLogFileStates: StartupLogFileState[] | null = null;
let startupLogLines: StartupLogLine[] = [];
let startupErrorState: StartupErrorPayload | null = null;

// ===== Electron 本地设置 =====
const ELECTRON_SETTINGS_FILE = 'electron-settings.json';

interface ElectronSettings {
  closeBehavior: 'ask' | 'tray' | 'quit';
  desktopHttps?: PersistentDesktopHttpsConfig;
  shortcuts?: ShortcutConfig;
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

const DEFAULT_ELECTRON_SETTINGS: ElectronSettings = {
  closeBehavior: 'ask',
  desktopHttps: DEFAULT_DESKTOP_HTTPS_CONFIG,
  shortcuts: createDefaultShortcutConfig(),
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
  const enabled = payload.enabled === true;
  if (!enabled) {
    if (voicePttShortcutCapture.webContentsId === null || voicePttShortcutCapture.webContentsId === webContentsId) {
      voicePttShortcutCapture.enabled = false;
      voicePttShortcutCapture.webContentsId = null;
      voicePttShortcutCapture.keyDownActive = false;
      voicePttShortcutCapture.lastKeyDownAt = null;
    }
    return { ...voicePttShortcutCapture };
  }

  voicePttShortcutCapture.enabled = true;
  voicePttShortcutCapture.preset = normalizeVoicePttShortcutPreset(payload.preset);
  voicePttShortcutCapture.webContentsId = webContentsId;
  voicePttShortcutCapture.keyDownActive = false;
  voicePttShortcutCapture.lastKeyDownAt = null;
  return { ...voicePttShortcutCapture };
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
  if (
    !voicePttShortcutCapture.enabled
    || voicePttShortcutCapture.webContentsId !== webContents.id
    || input.code !== voicePttShortcutCapture.preset
  ) {
    return false;
  }

  if (input.type !== 'keyDown' && input.type !== 'keyUp') {
    return false;
  }

  // Do not start PTT with modifiers, but always allow the matching keyUp to
  // release the debounce guard if the key was pressed before modifiers changed.
  if (inputHasModifier(input) && !(input.type === 'keyUp' && voicePttShortcutCapture.keyDownActive)) {
    return false;
  }

  event.preventDefault();

  if (input.type === 'keyUp') {
    voicePttShortcutCapture.keyDownActive = false;
    voicePttShortcutCapture.lastKeyDownAt = null;
    sendVoicePttShortcutCommand(webContents, input, 'keyup');
    return true;
  }

  if (input.isAutoRepeat) {
    return true;
  }

  const now = Date.now();
  if (voicePttShortcutCapture.keyDownActive) {
    const elapsedMs = voicePttShortcutCapture.lastKeyDownAt === null
      ? Number.POSITIVE_INFINITY
      : now - voicePttShortcutCapture.lastKeyDownAt;

    if (elapsedMs < VOICE_PTT_STALE_KEYDOWN_RECOVERY_MS) {
      return true;
    }

    logger.debug('Voice PTT shortcut keyUp was not observed; recovering debounce on fresh keyDown', {
      preset: voicePttShortcutCapture.preset,
      elapsedMs,
    });
  }

  voicePttShortcutCapture.keyDownActive = true;
  voicePttShortcutCapture.lastKeyDownAt = now;
  sendVoicePttShortcutCommand(webContents, input, 'keydown');
  return true;
}

function stopShortcutRecording(options: { restoreGlobalShortcuts?: boolean } = {}): void {
  shortcutRecordingWebContentsId = null;
  shortcutRecordingActionId = null;

  if (options.restoreGlobalShortcuts) {
    applyGlobalShortcutConfig(loadElectronSettings().shortcuts);
  }
}

function loadElectronSettings(): ElectronSettings {
  return readJsonWithBackupsSync<ElectronSettings>(
    getElectronSettingsPath(),
    () => ({
      ...DEFAULT_ELECTRON_SETTINGS,
      shortcuts: createDefaultShortcutConfig(),
    }),
    (parsed) => {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('settings root must be an object');
      }
      const settings = parsed as Partial<ElectronSettings>;
      return {
        ...DEFAULT_ELECTRON_SETTINGS,
        ...settings,
        desktopHttps: sanitizeDesktopHttpsConfig(settings.desktopHttps),
        shortcuts: normalizeShortcutConfig(settings.shortcuts),
      };
    },
  );
}

function saveElectronSettings(settings: ElectronSettings): void {
  try {
    const dir = getAppConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    safeWriteFileSync(getElectronSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, { backups: 3, mode: 0o600 });
  } catch (err) {
    logger.error('failed to save electron settings', err);
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

function applyGlobalShortcutConfig(configInput: unknown): ShortcutRegistrationStatus {
  const config = normalizeShortcutConfig(configInput);
  const status: ShortcutRegistrationStatus = {
    config,
    registered: [],
    failed: [],
  };

  unregisterGlobalShortcuts();

  for (const actionId of SHORTCUT_ACTION_IDS) {
    const accelerator = shortcutBindingToAccelerator(config[actionId]);
    if (!accelerator) continue;

    try {
      const ok = globalShortcut.register(accelerator, () => {
        if (!mainWindowInstance || mainWindowInstance.isDestroyed()) {
          logger.warn('shortcut command ignored because main window is unavailable', { actionId, accelerator });
          return;
        }
        mainWindowInstance.webContents.send('shortcut:command', { actionId, accelerator, source: 'electron' });
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
  const env: Record<string, string> = {
    PORT: String(selectedWebPort || DEFAULT_WEB_HTTP_PORT),
    TARGET: `http://127.0.0.1:${serverPort}`,
    PUBLIC: '1',
    TX5DR_CLIENT_TOOLS_LOG_FILE: getClientToolsLogPath(),
    TX5DR_CLIENT_TOOLS_READY_FILE: getClientToolsReadyPath(),
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

// ===== macOS 后台节流防护 =====
// 必须在 app.whenReady() 之前调用，阻止 App Nap 降低渲染进程定时器精度
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// ===== 认证 Token 管理 =====
let embeddedAdminToken: string | null = null;

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
  return value.replace(/([?&]auth_token=)[^&\s]*/g, '$1<redacted>');
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
  const res = resourcesRoot();
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  return path.join(res, 'bin', triplet(), exe);
}

async function ensureWindowsVCRuntimeInstalled(): Promise<boolean> {
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
  await createMainWindowOnly({ startHealthCheck: false });
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

  const msgs = getMessages(app.getLocale()).startupErrors;
  const template = msgs[kind];
  const actions = (options.actions ?? []).map((id): StartupErrorAction => ({
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

  if (!hasLoadingErrorSurface()) {
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
      logger.error(`[child:${name}] ${lines}`);
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

// 简单 HTTP 等待
async function waitForUrl(url: string, timeoutMs = 15000, intervalMs = 300): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    function once() {
      try {
        const u = new URL(url);
        const client = u.protocol === 'https:' ? https : http;
        const req = client.request(
          {
            hostname: u.hostname,
            port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
            path: `${u.pathname}${u.search}`,
            method: 'GET',
            timeout: 2000,
            ...(u.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
          },
          (res) => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) return resolve(true);
            res.resume();
            res.on('end', () => setTimeout(next, intervalMs));
          }
        );
        req.on('error', () => setTimeout(next, intervalMs));
        req.on('timeout', () => {
          req.destroy();
          setTimeout(next, intervalMs);
        });
        req.end();
      } catch {
        setTimeout(next, intervalMs);
      }
    }
    function next() {
      if (Date.now() - started > timeoutMs) return resolve(false);
      once();
    }
    once();
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
async function openAboutWindow(): Promise<void> {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    if (aboutWindow.isMinimized()) aboutWindow.restore();
    aboutWindow.focus();
    return;
  }

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
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: false,
        allowRunningInsecureContent: true,
        backgroundThrottling: false,
        preload: app.isPackaged
          ? join(process.resourcesPath, 'app', 'packages', 'electron-preload', 'dist', 'preload.js')
          : join(__dirname, '../../electron-preload/dist/preload.js'),
      },
    });

    if (process.platform === 'win32' || process.platform === 'linux') {
      aboutWindow.setMenuBarVisibility(false);
    }

    const aboutUrl = `${getWebUrl()}/about.html`;
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
  const urlWithAuth = embeddedAdminToken
    ? `${webUrl}?auth_token=${encodeURIComponent(embeddedAdminToken)}`
    : webUrl;
  logger.info(`loading URL: ${urlWithAuth}`);
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

  // 检查主窗口是否已存在且有效
  if (mainWindowInstance && !mainWindowInstance.isDestroyed()) {
    mainWindowInstance.show();
    mainWindowInstance.focus();
    return mainWindowInstance;
  }

  // 清理已销毁的主窗口引用
  if (mainWindowInstance) {
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      backgroundThrottling: false,
      preload: app.isPackaged
        ? join(process.resourcesPath, 'app', 'packages', 'electron-preload', 'dist', 'preload.js')
        : join(__dirname, '../../electron-preload/dist/preload.js'),
    },
  });

  logger.info('main window created');
  mainWindowInstance = mainWindow;

  // Windows/Linux: 关闭窗口时询问用户行为；后台模式销毁 renderer，避免隐藏窗口继续占用内存。
  if (process.platform !== 'darwin') {
    mainWindow.on('close', (event) => {
      if (isQuitting) return;

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
    logger.info('main window closed');
    mainWindowInstance = null;
    voicePttShortcutCapture.enabled = false;
    voicePttShortcutCapture.webContentsId = null;
    voicePttShortcutCapture.keyDownActive = false;
    voicePttShortcutCapture.lastKeyDownAt = null;
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mainWindow.webContents.on('render-process-gone', (_event: any, details: any) => {
    logger.error('renderer process gone', details);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mainWindow.webContents.on('console-message', (_event: any, level: any, message: any, _line: any, _sourceId: any) => {
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

  // 定期检查服务器健康状态
  if (options.startHealthCheck !== false) {
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

  // 先加载本地 loading 页面，避免白屏；主前端在服务就绪后单独切换。
  await mainWindow.loadFile(getLoadingPagePath());

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
  let windowInstance = mainWindowInstance && !mainWindowInstance.isDestroyed()
    ? mainWindowInstance
    : null;

  if (!windowInstance) {
    windowInstance = await createMainWindowOnly();
    if (mainAppReadyForWindow) {
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

  const url = embeddedAdminToken
    ? `${base}?auth_token=${encodeURIComponent(embeddedAdminToken)}`
    : base;
  await shell.openExternal(url);
}

function redactSensitiveUrl(value: string): string {
  return value.replace(/([?&]auth_token=)[^&]*/g, '$1<redacted>');
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

    logger.info('dev electron process memory', {
      reason,
      processes,
      childPids: {
        web: webProcess?.pid ?? null,
        server: serverProcess?.pid ?? null,
      },
    });
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

async function createWindow() {
  logger.info('createWindow called');

  // 检查主窗口是否已存在且有效
  if (mainWindowInstance && !mainWindowInstance.isDestroyed()) {
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
  hasStartupError = false;
  errorType = '';
  startupErrorDialogShown = false;
  startupErrorState = null;

  const isDevelopment = process.env.NODE_ENV === 'development' && !app.isPackaged;
  const startupErrorMsgs = getMessages(app.getLocale()).startupErrors;
  logger.info(`isDevelopment: ${isDevelopment}`);

  const startupWindow = await createMainWindowOnly();
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

    logger.warn('running native module check...');
    const nativeCheck = await runNativeModuleCheck(serverEntry);
    for (const mod of nativeCheck.modules) {
      if (mod.ok) {
        logger.warn(`native module ok: ${mod.name}`);
      } else {
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
    logger.warn('native module check complete');

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
        TX5DR_SERVER_ENTRY: serverEntry,
        TX5DR_INTERNAL_SHUTDOWN_TOKEN: internalShutdownToken,
        TX5DR_CONFIG_DIR: getAppConfigDir(),
        TX5DR_DATA_DIR: getAppDataDir(),
        TX5DR_LOGS_DIR: getAppLogsDir(),
        TX5DR_CACHE_DIR: getAppCacheDir(),
        TX5DR_SERVER_PORT_AUTO: '1',
        TX5DR_SERVER_PORT_SCAN_STEPS: String(DEFAULT_PORT_SCAN_STEPS),
        TX5DR_SERVER_READY_FILE: getServerReadyPath(),
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

  // 从 Server 生成的 .admin-token 文件读取管理员令牌
  for (let i = 0; i < 30; i++) {
    embeddedAdminToken = readAdminTokenFile();
    if (embeddedAdminToken) break;
    logger.debug(`waiting for .admin-token file... (${i + 1}/30)`);
    await new Promise(r => setTimeout(r, 1000));
  }
  if (embeddedAdminToken) {
    logger.info(`admin token ready: ${embeddedAdminToken.slice(0, 15)}...`);
  } else {
    logger.warn('admin token file not found, starting without authentication');
  }

  logger.info('services ready, loading main app');
  mainAppReadyForWindow = true;

  const targetWindow = mainWindowInstance && !mainWindowInstance.isDestroyed()
    ? mainWindowInstance
    : startupWindow && !startupWindow.isDestroyed()
      ? startupWindow
      : null;

  if (targetWindow) {
    await loadMainAppInWindow(targetWindow);
    return targetWindow;
  }

  logger.info('services ready but main window is closed; staying in background');
  return undefined;
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
  applyGlobalShortcutConfig(loadElectronSettings().shortcuts);

  const vcRuntimeOk = await ensureWindowsVCRuntimeInstalled();
  if (!vcRuntimeOk) return;

  logger.info('calling createWindow');
  await createWindow();
  logger.info('createWindow complete');
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


function getDesktopUpdateService(): DesktopUpdateService {
  if (!desktopUpdateService) {
    desktopUpdateService = new DesktopUpdateService({
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
      const childResults = await cleanup();
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
  ipcMain.handle('window:openAbout', async () => {
    logger.info('IPC window:openAbout');
    await openAboutWindow();
  });

  // 处理打开通联日志窗口的请求
  ipcMain.handle('window:openLogbook', async (_event, queryString: string) => {
    logger.info(`IPC window:openLogbook, queryString: ${queryString}`);

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
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false,
          allowRunningInsecureContent: true,
          backgroundThrottling: false,
          preload: app.isPackaged
            ? join(process.resourcesPath, 'app', 'packages', 'electron-preload', 'dist', 'preload.js')
            : join(__dirname, '../../electron-preload/dist/preload.js'),
        },
      });

      // 在 Windows 和 Linux 下隐藏菜单栏
      if (process.platform === 'win32' || process.platform === 'linux') {
        logbookWindow.setMenuBarVisibility(false);
      }

      // auth token 参数（通过 URL 参数传递，与主窗口一致）
      const authParam = embeddedAdminToken ? `&auth_token=${encodeURIComponent(embeddedAdminToken)}` : '';

      // 加载通联日志页面
      if (process.env.NODE_ENV === 'development' && !app.isPackaged) {
        // 开发模式：使用 Vite
        const logbookUrl = `${getWebUrl()}/logbook.html?${queryString}${authParam}`;
        logger.info(`IPC window:openLogbook loading dev URL: ${logbookUrl}`);
        await logbookWindow.loadURL(logbookUrl);
        if (shouldOpenDevTools()) {
          logbookWindow.webContents.openDevTools();
        }
      } else {
        // 生产模式：连接内置静态 web 服务
        const fullUrl = `${getWebUrl()}/logbook.html?${queryString}${authParam}`;
        logger.info(`IPC window:openLogbook loading prod URL: ${fullUrl}`);
        await logbookWindow.loadURL(fullUrl);
      }

      // 聚焦新窗口
      logbookWindow.focus();

      logger.info('IPC window:openLogbook window created');
    } catch (error) {
      logger.error('IPC window:openLogbook failed to create window', error);
      throw error;
    }
  });

  // 处理打开独立频谱图窗口的请求
  ipcMain.handle('window:openSpectrumWindow', async (_event) => {
    logger.info('IPC window:openSpectrumWindow');

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
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false,
          allowRunningInsecureContent: true,
          backgroundThrottling: false,
          preload: app.isPackaged
            ? join(process.resourcesPath, 'app', 'packages', 'electron-preload', 'dist', 'preload.js')
            : join(__dirname, '../../electron-preload/dist/preload.js'),
        },
      });

      // 在 Windows 和 Linux 下隐藏菜单栏
      if (process.platform === 'win32' || process.platform === 'linux') {
        spectrumWindow.setMenuBarVisibility(false);
      }

      // auth token 参数（通过 URL 参数传递，与主窗口一致）
      const authParam = embeddedAdminToken ? `?auth_token=${encodeURIComponent(embeddedAdminToken)}` : '';

      // 加载频谱图页面
      if (process.env.NODE_ENV === 'development' && !app.isPackaged) {
        const spectrumUrl = `${getWebUrl()}/spectrum.html${authParam}`;
        logger.info(`IPC window:openSpectrumWindow loading dev URL: ${spectrumUrl}`);
        await spectrumWindow.loadURL(spectrumUrl);
        if (shouldOpenDevTools()) {
          spectrumWindow.webContents.openDevTools();
        }
      } else {
        const fullUrl = `${getWebUrl()}/spectrum.html${authParam}`;
        logger.info(`IPC window:openSpectrumWindow loading prod URL: ${fullUrl}`);
        await spectrumWindow.loadURL(fullUrl);
      }

      // 聚焦新窗口
      spectrumWindow.focus();

      // 窗口关闭时通知主窗口，以便主窗口恢复显示频谱图
      spectrumWindow.on('closed', () => {
        if (mainWindowInstance && !mainWindowInstance.isDestroyed()) {
          mainWindowInstance.webContents.send('spectrum-window-closed');
        }
      });

      logger.info('IPC window:openSpectrumWindow window created');
    } catch (error) {
      logger.error('IPC window:openSpectrumWindow failed to create window', error);
      throw error;
    }
  });

  // 处理打开目录的请求（在系统文件管理器中打开）
  ipcMain.handle('shell:openPath', async (_event, dirPath: string) => {
    logger.info(`IPC shell:openPath: ${dirPath}`);

    try {
      // 验证路径存在
      if (!fs.existsSync(dirPath)) {
        // 尝试创建目录
        fs.mkdirSync(dirPath, { recursive: true });
      }

      // 使用系统文件管理器打开目录
      const result = await shell.openPath(dirPath);
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
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
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

  ipcMain.handle('fs:selectFile', async (event, options?: FsSelectFileOptions) => {
    logger.info('IPC fs:selectFile');
    const result = await showOpenDialogForEvent(event, {
      title: sanitizeDialogTitle(options?.title),
      filters: sanitizeFileDialogFilters(options?.filters),
      properties: ['openFile'],
    });

    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle('fs:selectDirectory', async (event, options?: FsSelectDirectoryOptions) => {
    logger.info('IPC fs:selectDirectory');
    const result = await showOpenDialogForEvent(event, {
      title: sanitizeDialogTitle(options?.title),
      properties: ['openDirectory', 'createDirectory'],
    });

    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getBuildInfo', () => BUILD_INFO);
  ipcMain.handle('app:quit', async () => {
    await cleanupAndQuit('renderer');
  });
  ipcMain.handle('app:restart', async () => {
    await cleanupAndQuit('renderer', { relaunch: true });
  });

  ipcMain.handle('startupLogs:subscribe', (event) => {
    ensureStartupLogsPolling();
    const webContentsId = event.sender.id;
    startupLogSubscribers.set(webContentsId, event.sender);
    const cleanupSubscriber = () => removeStartupLogSubscriber(webContentsId);
    event.sender.once('destroyed', cleanupSubscriber);
    event.sender.once('did-navigate', cleanupSubscriber);
    return createStartupLogsPayload(true);
  });

  ipcMain.handle('startupLogs:unsubscribe', (event) => {
    removeStartupLogSubscriber(event.sender.id);
  });

  ipcMain.handle('startupLogs:openFolder', async () => {
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

  ipcMain.handle('startupLogs:runAction', async (_event, actionId: StartupErrorActionId) => {
    logger.info(`IPC startupLogs:runAction: ${actionId}`);

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

  ipcMain.handle('updater:getStatus', () => {
    return getDesktopUpdateService().getStatus();
  });

  ipcMain.handle('updater:check', async () => {
    return getDesktopUpdateService().checkForUpdates();
  });

  ipcMain.handle('updater:openDownload', async (_event, url?: string) => {
    await getDesktopUpdateService().openDownload(url);
  });

  ipcMain.handle('updater:download', async () => {
    return getDesktopUpdateService().download();
  });

  ipcMain.handle('updater:installAndRestart', async () => {
    return getDesktopUpdateService().installAndRestart();
  });

  ipcMain.handle('https:getStatus', async () => {
    return getDesktopHttpsStatus();
  });

  ipcMain.handle('https:getShareUrls', async () => {
    const status = await getDesktopHttpsStatus();
    return status.shareUrls;
  });

  ipcMain.handle('https:generateSelfSigned', async () => {
    const settings = loadElectronSettings();
    const nextConfig = await generateSelfSignedCertificate({
      configDir: getAppConfigDir(),
      hostname: getHostname(),
      lanAddresses: getLanIpv4Addresses(),
      existingConfig: settings.desktopHttps,
    });
    return persistDesktopHttpsConfig(nextConfig);
  });

  ipcMain.handle('https:importPemCertificate', async (_event, certPath: string, keyPath: string) => {
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

  ipcMain.handle('https:applySettings', async (
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

  ipcMain.handle('https:disable', async () => {
    const settings = loadElectronSettings();
    const nextConfig = await disableDesktopHttps(settings.desktopHttps);
    return persistDesktopHttpsConfig(nextConfig);
  });

  ipcMain.handle('shortcuts:getConfig', () => {
    return loadElectronSettings().shortcuts ?? createDefaultShortcutConfig();
  });

  ipcMain.handle('shortcuts:setConfig', (_event, config: unknown) => {
    const settings = loadElectronSettings();
    const shortcuts = normalizeShortcutConfig(config);
    saveElectronSettings({ ...settings, shortcuts });
    return applyGlobalShortcutConfig(shortcuts);
  });

  ipcMain.handle('shortcuts:register', (_event, config?: unknown) => {
    if (config !== undefined) {
      const settings = loadElectronSettings();
      const shortcuts = normalizeShortcutConfig(config);
      saveElectronSettings({ ...settings, shortcuts });
      return applyGlobalShortcutConfig(shortcuts);
    }

    return applyGlobalShortcutConfig(loadElectronSettings().shortcuts);
  });

  ipcMain.handle('shortcuts:startRecording', (event, actionId: unknown) => {
    if (!isShortcutActionId(actionId)) {
      throw new Error('invalid_shortcut_action');
    }

    unregisterGlobalShortcuts();
    shortcutRecordingWebContentsId = event.sender.id;
    shortcutRecordingActionId = actionId;
  });

  ipcMain.handle('shortcuts:stopRecording', (event) => {
    if (shortcutRecordingWebContentsId === event.sender.id) {
      stopShortcutRecording({ restoreGlobalShortcuts: true });
    }
  });

  ipcMain.handle('voicePttShortcut:setConfig', (event, payload: VoicePttShortcutConfigPayload) => {
    return updateVoicePttShortcutCapture(event.sender.id, payload ?? {});
  });

  // 配置管理 IPC
  ipcMain.handle('config:get', (_event, key: keyof ElectronSettings) => {
    const settings = loadElectronSettings();
    return settings[key] ?? null;
  });

  ipcMain.handle('config:set', (_event, key: string, value: unknown) => {
    const settings = loadElectronSettings();
    (settings as unknown as Record<string, unknown>)[key] = value;
    saveElectronSettings(settings);
  });

  ipcMain.handle('config:getAll', () => {
    return loadElectronSettings();
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
