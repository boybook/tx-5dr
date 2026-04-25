import { app, BrowserWindow, ipcMain, shell, Tray, Menu, dialog, nativeTheme, powerSaveBlocker, session } from 'electron';
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
import { DesktopUpdateService } from './desktopUpdate.js';
import { createLogger } from './utils/logger.js';
import { getMessages } from './i18n.js';
import {
  DEFAULT_DESKTOP_HTTPS_CONFIG,
  buildDesktopHttpsStatus,
  disableDesktopHttps,
  generateSelfSignedCertificate,
  importPemCertificate,
  sanitizeDesktopHttpsConfig,
  type PersistentDesktopHttpsConfig,
} from './desktopHttps.js';

// 获取当前模块的目录(ESM中的__dirname替代方案)
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = dirname(__filename);

const logger = createLogger('ElectronMain');
const desktopUpdateService = new DesktopUpdateService();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverCheckInterval: any = null;
let livekitProcess: import('node:child_process').ChildProcess | null = null;
let serverProcess: import('node:child_process').ChildProcess | null = null;
let webProcess: import('node:child_process').ChildProcess | null = null;
let selectedLiveKitPort: number | null = null;
let selectedWebPort: number | null = null;
let selectedServerPort: number | null = null;

// 启动错误跟踪
let errorType: string = ''; // 错误类型，空字符串表示无错误
let hasStartupError: boolean = false; // 是否发生启动错误
let crashedProcessName: string = ''; // 崩溃的子进程名
let mainWindowInstance: BrowserWindow | null = null; // 主窗口实例
let trayInstance: Tray | null = null; // 系统托盘实例（Windows/Linux）
let isQuitting: boolean = false; // 主动退出标志，防止子进程被杀时弹崩溃错误
let notificationPermissionHandlersConfigured = false;

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

const CHILD_SHUTDOWN_OPTIONS: Record<'web' | 'server' | 'livekit', ChildShutdownOptions> = {
  web: { softTimeoutMs: 1000, forceTimeoutMs: 400 },
  server: { softTimeoutMs: 1800, forceTimeoutMs: 500 },
  livekit: { softTimeoutMs: 1000, forceTimeoutMs: 400 },
};

// ===== Electron 本地设置 =====
const ELECTRON_SETTINGS_FILE = 'electron-settings.json';

interface ElectronSettings {
  closeBehavior: 'ask' | 'tray' | 'quit';
  desktopHttps?: PersistentDesktopHttpsConfig;
}

interface LiveKitCredentialFileData {
  apiKey: string;
  apiSecret: string;
  createdAt: string;
  rotatedAt: string;
}

interface WindowsVCRuntimeStatus {
  installed: boolean;
  versionOk: boolean;
  version: string | null;
  source: 'registry' | 'filesystem' | 'missing';
  detail: string;
}

const DEFAULT_ELECTRON_SETTINGS: ElectronSettings = {
  closeBehavior: 'ask',
  desktopHttps: DEFAULT_DESKTOP_HTTPS_CONFIG,
};
const VC_REDIST_X64_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const VC_REDIST_REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
] as const;
const VC_REDIST_REQUIRED_DLLS = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'] as const;
const VC_REDIST_MIN_VERSION = { major: 14, minor: 30 } as const; // VS 2022 = 14.3x series

function getElectronSettingsPath(): string {
  return path.join(getAppConfigDir(), ELECTRON_SETTINGS_FILE);
}

function loadElectronSettings(): ElectronSettings {
  try {
    const raw = fs.readFileSync(getElectronSettingsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_ELECTRON_SETTINGS,
      ...parsed,
      desktopHttps: sanitizeDesktopHttpsConfig(parsed?.desktopHttps),
    };
  } catch {
    return { ...DEFAULT_ELECTRON_SETTINGS };
  }
}

function saveElectronSettings(settings: ElectronSettings): void {
  try {
    const dir = getAppConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getElectronSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    logger.error('failed to save electron settings', err);
  }
}

function getDesktopHttpsConfig(): PersistentDesktopHttpsConfig {
  return sanitizeDesktopHttpsConfig(loadElectronSettings().desktopHttps);
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
    httpPort: selectedWebPort || 5173,
    lanAddresses: getLanIpv4Addresses(),
  });
}

function buildWebChildEnv(serverPort: number): Record<string, string> {
  const httpsConfig = getDesktopHttpsConfig();
  const env: Record<string, string> = {
    PORT: String(selectedWebPort || 5173),
    TARGET: `http://127.0.0.1:${serverPort}`,
    PUBLIC: '1',
  };

  if (isDevelopmentRuntime()) {
    env.DEV_WEB_TARGET = 'http://127.0.0.1:5173';
  } else {
    env.STATIC_DIR = join(resourcesRoot(), 'app', 'packages', 'web', 'dist');
  }

  const livekitTarget = resolveLiveKitGatewayTarget();
  if (livekitTarget) {
    env.LIVEKIT_TARGET = livekitTarget;
  }

  if (
    httpsConfig.enabled &&
    httpsConfig.certPath &&
    httpsConfig.keyPath &&
    fs.existsSync(httpsConfig.certPath) &&
    fs.existsSync(httpsConfig.keyPath)
  ) {
    env.HTTPS_ENABLE = '1';
    env.HTTPS_PORT = String(httpsConfig.httpsPort);
    env.HTTPS_CERT_FILE = httpsConfig.certPath;
    env.HTTPS_KEY_FILE = httpsConfig.keyPath;
    env.HTTPS_REDIRECT_EXTERNAL_HTTP = httpsConfig.redirectExternalHttp ? '1' : '0';
  }

  return env;
}

function resolveLiveKitGatewayTarget(): string | null {
  if (process.env.LIVEKIT_DISABLED === '1' && !selectedLiveKitPort) {
    return null;
  }

  if (selectedLiveKitPort) {
    return `http://127.0.0.1:${selectedLiveKitPort}`;
  }

  const raw = process.env.LIVEKIT_URL?.trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    return parsed.toString().replace(/\/$/, '');
  } catch (error) {
    logger.warn('failed to resolve livekit gateway target from environment', { raw, error });
    return null;
  }
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

async function restartWebGateway(): Promise<void> {
  if (!selectedServerPort || !selectedWebPort) {
    throw new Error('web_gateway_not_ready');
  }

  const webEntry = webGatewayEntryPath();
  const env = buildWebChildEnv(selectedServerPort);

  if (webProcess) {
    await killProcess(webProcess, 'web');
    webProcess = null;
  }

  webProcess = runChild('client-tools', webEntry, env);

  try {
    await waitForWebGatewayReady(env, selectedWebPort);
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
  const next = sanitizeDesktopHttpsConfig({
    ...current,
    ...update,
  });

  if (next.enabled) {
    const nextStatus = await buildDesktopHttpsStatus({
      configDir: getAppConfigDir(),
      config: next,
      hostname: getHostname(),
      httpPort: selectedWebPort || 5173,
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

function getAppLogsDir(): string {
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Logs', APP_DIR_NAME);
  } else if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), APP_DIR_NAME, 'logs');
  } else {
    return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), APP_DIR_NAME, 'logs');
  }
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
async function findFreePort(start: number, maxStep = 50, avoid?: number, host = '0.0.0.0'): Promise<number> {
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

function livekitServerPath() {
  if (process.env.LIVEKIT_BINARY_PATH) {
    return fs.existsSync(process.env.LIVEKIT_BINARY_PATH) ? process.env.LIVEKIT_BINARY_PATH : null;
  }

  const res = resourcesRoot();
  const exe = process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server';
  const bundled = path.join(res, 'bin', triplet(), exe);
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  const candidates = [resolveCommand(exe)];
  if (process.platform === 'darwin') {
    candidates.push(
      '/opt/homebrew/bin/livekit-server',
      '/opt/homebrew/opt/livekit/bin/livekit-server',
      '/usr/local/bin/livekit-server',
      '/usr/local/opt/livekit/bin/livekit-server',
    );
  } else if (process.platform === 'linux') {
    candidates.push('/usr/local/bin/livekit-server', '/usr/bin/livekit-server');
  }

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function resolveCommand(command: string): string | null {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [command], { encoding: 'utf8' })
    : spawnSync('which', [command], { encoding: 'utf8' });
  if (probe.status !== 0) {
    return null;
  }

  const resolved = probe.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return resolved || null;
}

function queryWindowsRegistryValue(key: string, valueName: string): string | null {
  const probe = spawnSync('reg', ['query', key, '/v', valueName], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (probe.status !== 0) {
    return null;
  }

  const pattern = new RegExp(`^\\s*${valueName}\\s+REG_\\w+\\s+(.+)$`, 'im');
  const match = probe.stdout.match(pattern);
  return match?.[1]?.trim() || null;
}

function parseVCRuntimeVersion(versionStr: string): { major: number; minor: number } | null {
  const match = versionStr.match(/^v?(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10) };
}

function isVCRuntimeVersionSufficient(versionStr: string): boolean {
  const parsed = parseVCRuntimeVersion(versionStr);
  if (!parsed) return false;
  if (parsed.major !== VC_REDIST_MIN_VERSION.major) {
    return parsed.major > VC_REDIST_MIN_VERSION.major;
  }
  return parsed.minor >= VC_REDIST_MIN_VERSION.minor;
}

function detectWindowsVCRuntime(): WindowsVCRuntimeStatus {
  if (process.platform !== 'win32') {
    return { installed: true, versionOk: true, version: null, source: 'registry', detail: 'not-applicable' };
  }

  for (const key of VC_REDIST_REGISTRY_KEYS) {
    const installed = queryWindowsRegistryValue(key, 'Installed');
    if (installed === '0x1' || installed === '1') {
      const version = queryWindowsRegistryValue(key, 'Version') || 'unknown';
      const versionOk = version !== 'unknown' && isVCRuntimeVersionSufficient(version);
      return {
        installed: true,
        versionOk,
        version,
        source: 'registry',
        detail: `${key} (Version=${version})`,
      };
    }
  }

  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const system32 = path.join(systemRoot, 'System32');
  const missingDlls = VC_REDIST_REQUIRED_DLLS.filter((dllName) => !fs.existsSync(path.join(system32, dllName)));
  if (missingDlls.length === 0) {
    return {
      installed: true,
      versionOk: true,
      version: null,
      source: 'filesystem',
      detail: system32,
    };
  }

  return {
    installed: false,
    versionOk: false,
    version: null,
    source: 'missing',
    detail: `missing DLLs: ${missingDlls.join(', ')}`,
  };
}

async function ensureWindowsVCRuntimeInstalled(): Promise<boolean> {
  if (process.platform !== 'win32') {
    return true;
  }

  const runtimeStatus = detectWindowsVCRuntime();

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
  const response = await dialog.showMessageBox({
    type: isOutdated ? 'warning' : 'error',
    title: dialogMsgs.title,
    message: dialogMsgs.message,
    detail: `${dialogMsgs.detail}\n${VC_REDIST_X64_URL}`,
    buttons: dialogMsgs.buttons,
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (response.response === 0) {
    try {
      await shell.openExternal(VC_REDIST_X64_URL);
    } catch (error) {
      logger.error('failed to open VC runtime download link', error);
    }
    app.quit();
    return false;
  }

  return true;
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

    logger.info(`stopping child process: ${name} (PID: ${proc.pid})`);

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
      logger.info(`child process ${name} exited (code: ${code}, signal: ${signal})`);
      finish();
    };

    const escalate = () => {
      if (hasChildExited(proc)) {
        finish();
        return;
      }

      forced = true;
      logger.warn(`child process ${name} exceeded soft timeout, force killing`);
      forceKillChild(proc, name);

      forceTimer = setTimeout(() => {
        if (!hasChildExited(proc)) {
          logger.warn(`child process ${name} did not exit after force kill request`);
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
  const wsjtxPrebuildDir = path.join(res, 'app', 'node_modules', 'wsjtx-lib', 'prebuilds', triplet());
  return {
    ...process.env,
    NODE_ENV: 'production',
    APP_RESOURCES: res,
    // 明确为子进程提供模块解析路径，确保能解析到 app/node_modules
    NODE_PATH: path.join(res, 'app', 'node_modules'),
    ...(process.platform === 'win32'
      ? {
          PATH: `${process.env.PATH};${path.join(res, 'native')}`,
        }
      : process.platform === 'darwin'
      ? {
          // macOS 动态库搜索路径，附带 wsjtx-lib 预编译目录
          DYLD_LIBRARY_PATH: `${wsjtxPrebuildDir}:${path.join(res, 'native')}:${process.env.DYLD_LIBRARY_PATH || ''}`,
        }
      : {
          // Linux 动态库搜索路径，附带 wsjtx-lib 预编译目录
          LD_LIBRARY_PATH: `${wsjtxPrebuildDir}:${path.join(res, 'native')}:${process.env.LD_LIBRARY_PATH || ''}`,
        }),
    ...extraEnv,
  } as NodeJS.ProcessEnv;
}

function buildLogPathsHint(name: string): string {
  const logPath = log.transports.file.getFile().path;
  const logsDir = path.dirname(logPath);
  const serverLogPath = path.join(logsDir, 'tx5dr-server.log');
  if (name === 'server') {
    return `Log files:\n  - ${serverLogPath}\n  - ${logPath}`;
  }
  return `Log files:\n  - ${logPath}\n  - ${serverLogPath}`;
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
    logger.info(`[child:${name}] exited with code ${code}, signal ${signal}`);

    if (isQuitting) return;

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
      dialog.showErrorBox('TX-5DR - Startup Failed',
        `${name} process ${reason}\n\n${buildLogPathsHint(name)}${stderrHint}`);
    }
  });

  child.on('error', (err) => {
    logger.error(`[child:${name}] failed to start: ${err.message}`);
    if (!crashedProcessName) {
      crashedProcessName = name;
    }
    hasStartupError = true;
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

  const child = spawn(NODE, [entryAbs], {
    cwd: path.dirname(entryAbs),
    env: createChildEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  wireChildProcess(name, child);
  return child;
}

interface NativeModuleCheckResult {
  /** All modules loaded successfully and script exited cleanly */
  success: boolean;
  /** Per-module results collected before the process exited */
  modules: Array<{ name: string; ok: boolean; error?: string }>;
  /** Module that was being loaded when the process crashed (null if no crash) */
  crashedModule: string | null;
  /** Process exit code */
  exitCode: number | null;
  /** Signal that killed the process */
  signal: string | null;
  /** True if the check was aborted due to timeout */
  timeout: boolean;
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
      finish({
        success: code === 0,
        modules,
        crashedModule: code !== 0 ? lastChecking : null,
        exitCode: code,
        signal: signal as string | null,
        timeout: false,
      });
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

function runBinaryChild(
  name: string,
  binaryPath: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  cwd = path.dirname(binaryPath)
) {
  const child = spawn(binaryPath, args, {
    cwd,
    env: createChildEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  wireChildProcess(name, child);
  return child;
}

function buildLiveKitConfig(signalingPort: number, tcpPort: number, apiKey: string, apiSecret: string): string {
  const runtimeSettings = readManagedLiveKitSettings();
  return [
    `port: ${signalingPort}`,
    'rtc:',
    `  tcp_port: ${tcpPort}`,
    '  port_range_start: 50000',
    '  port_range_end: 50100',
    ...(runtimeSettings.networkMode === 'internet-auto'
      ? ['  use_external_ip: true']
      : [
          '  use_external_ip: false',
          ...(runtimeSettings.networkMode === 'internet-manual' && runtimeSettings.nodeIp
            ? [`  node_ip: ${runtimeSettings.nodeIp}`]
            : []),
        ]),
    'keys:',
    `  ${apiKey}: ${apiSecret}`,
    'logging:',
    '  level: info',
    '',
  ].join('\n');
}

function readManagedLiveKitSettings(): { networkMode: 'lan' | 'internet-auto' | 'internet-manual'; nodeIp: string | null } {
  const configPath = path.join(getAppConfigDir(), 'config.json');

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content) as {
      livekitNetworkMode?: string | null;
      livekitNodeIp?: string | null;
    };
    const networkMode = parsed.livekitNetworkMode === 'internet-auto' || parsed.livekitNetworkMode === 'internet-manual'
      ? parsed.livekitNetworkMode
      : 'lan';
    const nodeIp = parsed.livekitNodeIp?.trim() || null;

    if (networkMode === 'internet-manual' && nodeIp && net.isIP(nodeIp) === 4) {
      return { networkMode, nodeIp };
    }
    if (networkMode === 'internet-manual') {
      logger.warn('invalid manual LiveKit node IP in desktop config, falling back to lan mode', { nodeIp });
      return { networkMode: 'lan', nodeIp: null };
    }

    return { networkMode, nodeIp };
  } catch (error) {
    logger.debug('failed to read desktop LiveKit runtime settings, using defaults', {
      message: error instanceof Error ? error.message : String(error),
    });
    return { networkMode: 'lan', nodeIp: null };
  }
}

function getLiveKitCredentialPath(): string {
  return path.join(getAppConfigDir(), 'livekit-credentials.env');
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function renderLiveKitCredentialEnv(data: LiveKitCredentialFileData): string {
  return [
    '# Managed by TX-5DR. Rotate this file only via TX-5DR tools.',
    `LIVEKIT_API_KEY=${data.apiKey}`,
    `LIVEKIT_API_SECRET=${data.apiSecret}`,
    `LIVEKIT_CREDENTIALS_CREATED_AT=${data.createdAt}`,
    `LIVEKIT_CREDENTIALS_ROTATED_AT=${data.rotatedAt}`,
    '',
  ].join('\n');
}

function ensureLiveKitCredentials(): { path: string; data: LiveKitCredentialFileData } {
  const configDir = getAppConfigDir();
  fs.mkdirSync(configDir, { recursive: true });
  const credentialPath = getLiveKitCredentialPath();

  try {
    if (fs.existsSync(credentialPath)) {
      const parsed = parseEnvFile(fs.readFileSync(credentialPath, 'utf-8'));
      const apiKey = parsed.LIVEKIT_API_KEY?.trim();
      const apiSecret = parsed.LIVEKIT_API_SECRET?.trim();
      if (apiKey && apiSecret) {
        const createdAt = parsed.LIVEKIT_CREDENTIALS_CREATED_AT?.trim() || new Date().toISOString();
        const rotatedAt = parsed.LIVEKIT_CREDENTIALS_ROTATED_AT?.trim() || createdAt;
        return {
          path: credentialPath,
          data: { apiKey, apiSecret, createdAt, rotatedAt },
        };
      }
    }
  } catch (error) {
    logger.warn('failed to read existing LiveKit credentials, regenerating', error);
  }

  const now = new Date().toISOString();
  const data: LiveKitCredentialFileData = {
    apiKey: `tx5dr-${randomBytes(8).toString('hex')}`,
    apiSecret: randomBytes(24).toString('hex'),
    createdAt: now,
    rotatedAt: now,
  };
  fs.writeFileSync(credentialPath, renderLiveKitCredentialEnv(data), 'utf-8');
  return { path: credentialPath, data };
}

function ensureLiveKitConfig(signalingPort: number, tcpPort: number, apiKey: string, apiSecret: string): string {
  const configDir = getAppConfigDir();
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'livekit.resolved.yaml');
  fs.writeFileSync(configPath, buildLiveKitConfig(signalingPort, tcpPort, apiKey, apiSecret), 'utf-8');
  return configPath;
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

async function waitForWebGatewayReady(
  env: Record<string, string>,
  webPort: number,
  timeoutMs = 15000,
  intervalMs = 200,
): Promise<void> {
  const httpOk = await waitForUrl(`http://127.0.0.1:${webPort}`, timeoutMs, intervalMs);
  if (!httpOk) {
    throw new Error('web_service_restart_timeout');
  }

  if (env.HTTPS_ENABLE === '1' && env.HTTPS_PORT) {
    const httpsOk = await waitForUrl(`https://127.0.0.1:${env.HTTPS_PORT}`, timeoutMs, intervalMs);
    if (!httpsOk) {
      throw new Error('web_https_restart_timeout');
    }
  }
}

/**
 * 构建右键菜单（托盘和 Dock 共用）
 */
function buildContextMenu(includQuit: boolean): Menu {
  const msgs = getMessages(app.getLocale());
  const template: Parameters<typeof Menu.buildFromTemplate>[0] = [
    { label: msgs.menu.openMainWindow, click: () => showMainWindow() },
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
 * 获取当前 web 界面 URL
 */
function getWebUrl(): string {
  if (process.env.NODE_ENV === 'development' && !app.isPackaged) {
    return 'http://localhost:5173';
  }
  return `http://127.0.0.1:${selectedWebPort || 5173}`;
}

/**
 * 仅创建主窗口（不启动子进程），用于托盘/Dock恢复窗口
 */
async function createMainWindowOnly(): Promise<BrowserWindow> {
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

  // Windows/Linux: 关闭窗口时询问用户行为（macOS 遵循平台惯例直接隐藏）
  if (process.platform !== 'darwin') {
    mainWindow.on('close', (event) => {
      if (isQuitting) return;

      const settings = loadElectronSettings();

      if (settings.closeBehavior === 'tray') {
        event.preventDefault();
        mainWindow.hide();
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
          mainWindow.hide();
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

  if (process.platform === 'win32' || process.platform === 'linux') {
    mainWindow.setMenuBarVisibility(false);
  }

  // 定期检查服务器健康状态
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

  // 先加载本地 loading 页面，避免白屏
  const loadingPath = app.isPackaged
    ? join(process.resourcesPath, 'app', 'packages', 'electron-main', 'assets', 'loading.html')
    : join(__dirname, '../assets/loading.html');
  await mainWindow.loadFile(loadingPath);

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

  // 导航到前端服务页面（通过 URL 参数传递 auth token 实现自动登录）
  const webUrl = getWebUrl();
  const urlWithAuth = embeddedAdminToken
    ? `${webUrl}?auth_token=${encodeURIComponent(embeddedAdminToken)}`
    : webUrl;
  logger.info(`loading URL: ${urlWithAuth}`);
  await mainWindow.loadURL(urlWithAuth);

  setupIpcHandlers();
  return mainWindow;
}

/**
 * 显示主窗口，若已销毁则重新创建（不重启子进程）
 */
function showMainWindow() {
  if (mainWindowInstance && !mainWindowInstance.isDestroyed()) {
    mainWindowInstance.show();
    mainWindowInstance.focus();
    if (mainWindowInstance.isMinimized()) {
      mainWindowInstance.restore();
    }
  } else {
    void createMainWindowOnly();
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
  logger.info(`opening logs in terminal: ${logDir}`);

  // 收集存在的日志文件
  const logFiles = [electronLogPath];
  if (fs.existsSync(serverLogPath)) {
    logFiles.push(serverLogPath);
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

async function checkServerHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const options = {
      hostname: '127.0.0.1', // 明确使用 IPv4
      port: selectedServerPort || 4000,
      path: '/',
      method: 'GET',
      timeout: 2000
    };

    logger.debug(`health check: connecting to http://127.0.0.1:${options.port}/`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = http.request(options, (res: any) => {
      logger.debug(`health check: response status ${res.statusCode}`);

      let data = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res.on('data', (chunk: any) => {
        data += chunk;
      });

      res.on('end', () => {
        logger.debug(`health check: response body: ${data}`);
        resolve((res.statusCode || 0) < 500);
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    req.on('error', (err: any) => {
      logger.debug(`health check: connection error: ${err.message}`);
      resolve(false);
    });

    req.on('timeout', () => {
      logger.debug('health check: connection timeout');
      resolve(false);
    });

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
      tasks.push(killProcess(currentServerProcess, 'server', CHILD_SHUTDOWN_OPTIONS.server));
    }

    const currentLivekitProcess = livekitProcess;
    livekitProcess = null;
    if (currentLivekitProcess) {
      tasks.push(killProcess(currentLivekitProcess, 'livekit', CHILD_SHUTDOWN_OPTIONS.livekit));
    }
  }

  return Promise.all(tasks);
}

// 清理函数
async function cleanup(): Promise<ChildShutdownResult[]> {
  const isDevelopment = process.env.NODE_ENV === 'development' && !app.isPackaged;
  const childResults = await cleanupChildProcesses(isDevelopment);

  selectedLiveKitPort = null;
  selectedServerPort = null;
  selectedWebPort = null;

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

  const isDevelopment = process.env.NODE_ENV === 'development' && !app.isPackaged;
  logger.info(`isDevelopment: ${isDevelopment}`);

  // Admin Token 将从 Server 生成的 .admin-token 文件中读取
  // 在 server 就绪后轮询获取

  if (isDevelopment) {
    logger.info('development mode: using external server (http://localhost:5173)');

    // 在开发模式下，等待前端 Vite 服务器准备就绪
    logger.info('waiting for frontend server...');
    const webReady = await waitForHttp('http://localhost:5173', 30000, 300);

    if (!webReady) {
      logger.error('cannot connect to frontend server (http://localhost:5173)');
      errorType = 'TIMEOUT';
      hasStartupError = true;
      const logPath = log.transports.file.getFile().path;
      dialog.showErrorBox('TX-5DR - Startup Failed',
        `Cannot connect to dev server (http://localhost:5173)\nPlease run yarn dev\n\nLog file: ${logPath}`);
      return;
    }

    logger.info('frontend server connected');

    // 等待后端服务器准备就绪
    logger.info('waiting for backend server...');
    const serverReady = await waitForHttp('http://localhost:4000', 30000, 300);

    if (!serverReady) {
      logger.error('cannot connect to backend server (http://localhost:4000)');
      errorType = 'TIMEOUT';
      hasStartupError = true;
      const logPath = log.transports.file.getFile().path;
      dialog.showErrorBox('TX-5DR - Startup Failed',
        `Cannot connect to backend server (http://localhost:4000)\nPlease run yarn dev\n\nLog file: ${logPath}`);
      return;
    }

    logger.info('backend server connected');

    selectedServerPort = 4000;
    selectedWebPort = await findFreePort(5174, 50, selectedServerPort, '0.0.0.0');

    const webEntry = webGatewayEntryPath();
    const webEnv = buildWebChildEnv(selectedServerPort);

    logger.info(`starting development browser gateway on port ${selectedWebPort}`);
    webProcess = runChild('client-tools', webEntry, webEnv);

    try {
      await waitForWebGatewayReady(webEnv, selectedWebPort);
      logger.info('development browser gateway ready');
    } catch (error) {
      if (webProcess) {
        await killProcess(webProcess, 'web');
        webProcess = null;
      }
      logger.error('development browser gateway startup timeout', error);
      errorType = 'TIMEOUT';
      hasStartupError = true;
      const logPath = log.transports.file.getFile().path;
      dialog.showErrorBox('TX-5DR - Startup Failed',
        `Development browser gateway startup timeout\n\n${error instanceof Error ? `${error.message}\n\n` : ''}Log file: ${logPath}`);
      return;
    }
  } else {
    // 生产模式：启动 LiveKit -> server -> web
    logger.info('production mode: starting livekit, server, and web child processes');
    const res = resourcesRoot();
    const livekitBinary = livekitServerPath();
    const serverEntry = join(res, 'app', 'packages', 'server', 'dist', 'index.js');
    const serverLauncherEntry = serverLauncherEntryPath();
    const webEntry = webGatewayEntryPath();
    const livekitEnabled = Boolean(livekitBinary);
    if (!livekitEnabled) {
      logger.warn('livekit binary not found, starting in ws compatibility mode');
    }

    // 自动端口探测，避免端口占用导致启动失败
    const livekitPort = livekitEnabled ? await findFreePort(7880, 50, undefined, '127.0.0.1') : null;
    const livekitTcpPort = livekitEnabled ? await findFreePort(7881, 50, livekitPort ?? undefined, '127.0.0.1') : null;
    const serverPort = await findFreePort(4000, 50, undefined, '0.0.0.0');
    const webPort = await findFreePort(5173, 50, serverPort, '0.0.0.0'); // 避免和 serverPort 冲突
    selectedLiveKitPort = livekitPort;
    selectedServerPort = serverPort;
    selectedWebPort = webPort;

    logger.info(`ports selected: livekit=${livekitPort ?? 'disabled'}, livekitTcp=${livekitTcpPort ?? 'disabled'}, server=${serverPort}, web=${webPort}`);

    let livekitCredentialPath: string | null = null;
    let livekitConfigPath: string | null = null;

    if (livekitEnabled && livekitBinary && livekitPort && livekitTcpPort) {
      const credentialState = ensureLiveKitCredentials();
      livekitCredentialPath = credentialState.path;
      livekitConfigPath = ensureLiveKitConfig(
        livekitPort,
        livekitTcpPort,
        credentialState.data.apiKey,
        credentialState.data.apiSecret,
      );

      livekitProcess = runBinaryChild('livekit', livekitBinary, ['--config', livekitConfigPath]);

      // Non-blocking: monitor LiveKit readiness in background.
      // Server's LiveKitBridgeManager will auto-detect availability via recovery probe.
      void waitForHttp(`http://127.0.0.1:${livekitPort}`, 15000, 200).then(async (livekitOk) => {
        if (!livekitOk) {
          logger.warn('livekit startup timeout, server will operate in ws-compat mode and auto-recover when livekit becomes available');
          if (livekitProcess) {
            await killProcess(livekitProcess, 'livekit');
            livekitProcess = null;
          }
        } else {
          logger.info('livekit service ready');
        }
      }).catch((error) => {
        logger.warn('livekit readiness check failed', error);
      });
    }

    // Pre-flight: check native modules in an isolated child process
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

      let detail: string;
      if (nativeCheck.crashedModule) {
        logger.error(`native module crashed the check process: ${nativeCheck.crashedModule} (exit=${nativeCheck.exitCode}, signal=${nativeCheck.signal})`);
        detail = `The following module crashed during loading:\n  ${nativeCheck.crashedModule}`;
      } else if (nativeCheck.timeout) {
        logger.error('native module check timed out');
        detail = 'The native module check process timed out (30s).';
      } else {
        detail = 'The following modules failed to load:\n' +
          failedModules.map(m => `  ${m.name}: ${m.error}`).join('\n');
      }

      const okHint = okModules.length > 0
        ? `\nSuccessfully loaded: ${okModules.join(', ')}`
        : '';
      const failHint = failedModules.length > 0
        ? `\nFailed to load: ${failedModules.map(m => m.name).join(', ')}`
        : '';

      hasStartupError = true;
      errorType = 'NATIVE_MODULE';
      dialog.showErrorBox('TX-5DR - Startup Failed',
        `Native module compatibility check failed.\n${detail}${okHint}${failHint}\n\n` +
        'This usually means the native binary is incompatible with the current system.\n\n' +
        buildLogPathsHint('server'));
      return;
    }
    logger.warn('all native modules ok');

    // Start server immediately — do not wait for LiveKit to become ready.
    // Server's LiveKitBridgeManager handles LiveKit availability detection
    // and recovery probing, falling back to ws-compat when unavailable.
    serverProcess = runChild('server', serverLauncherEntry, {
      PORT: String(serverPort),
      WEB_PORT: String(webPort),
      TX5DR_SERVER_ENTRY: serverEntry,
      LIVEKIT_DISABLED: livekitEnabled ? '0' : '1',
      ...(livekitEnabled && livekitPort && livekitTcpPort && livekitCredentialPath && livekitConfigPath
        ? {
            LIVEKIT_URL: `ws://127.0.0.1:${livekitPort}`,
            LIVEKIT_CREDENTIALS_FILE: livekitCredentialPath,
            LIVEKIT_CONFIG_PATH: livekitConfigPath,
            LIVEKIT_TCP_PORT: String(livekitTcpPort),
            LIVEKIT_UDP_PORT_RANGE: '50000-50100',
          }
        : {}),
    });

    logger.info('waiting for backend server...');
    const serverOk = await waitForHttp(`http://127.0.0.1:${selectedServerPort}`, 15000, 200);
    if (!serverOk) {
      logger.error('backend server startup timeout');
      errorType = 'TIMEOUT';
      crashedProcessName = crashedProcessName || 'server';
      hasStartupError = true;
      dialog.showErrorBox('TX-5DR - Startup Failed',
        `Backend server startup timeout\n\n` +
        `Backend port: ${serverPort}\n` +
        `LiveKit mode: ${livekitProcess ? 'enabled' : 'disabled (ws-compat fallback)'}\n` +
        `${livekitPort ? `LiveKit signaling port: ${livekitPort}\n` : ''}` +
        `${livekitTcpPort ? `LiveKit ICE/TCP port: ${livekitTcpPort}\n` : ''}` +
        `${livekitConfigPath ? `Config file: ${livekitConfigPath}\n` : ''}` +
        `${buildLogPathsHint('server')}\n\n` +
        'Please inspect the backend and LiveKit logs to confirm the realtime voice service is reachable.');
      return;
    }
    logger.info('backend server ready');

    const webEnv = buildWebChildEnv(serverPort);
    webProcess = runChild('client-tools', webEntry, webEnv);

    try {
      await waitForWebGatewayReady(webEnv, selectedWebPort);
    } catch (error) {
      if (webProcess) {
        await killProcess(webProcess, 'web');
        webProcess = null;
      }
      logger.error('web service startup timeout');
      errorType = 'TIMEOUT';
      crashedProcessName = crashedProcessName || 'client-tools';
      hasStartupError = true;
      dialog.showErrorBox('TX-5DR - Startup Failed',
        `Web service startup timeout\n\n${error instanceof Error ? `${error.message}\n\n` : ''}${buildLogPathsHint('client-tools')}`);
      return;
    }
    logger.info('web service ready');
  }

  // 最后检查：如果子进程已经崩溃
  if (hasStartupError) {
    logger.error('startup error detected', { errorType, crashedProcessName });
    const processHint = crashedProcessName ? ` [${crashedProcessName}]` : '';
    dialog.showErrorBox('TX-5DR - Startup Failed',
      `Error detected during startup (${errorType}${processHint})\n\n${buildLogPathsHint(crashedProcessName || 'server')}`);
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

  logger.info('services ready, creating main window');
  return createMainWindowOnly();
}

// 启动应用
const startApp = async () => {
  await app.whenReady();

  logger.info('app ready');

  // 初始化 electron-log：统一日志目录到与 server AppPaths 一致的位置
  const logsDir = getAppLogsDir();
  fs.mkdirSync(logsDir, { recursive: true });
  log.transports.file.resolvePathFn = () => path.join(logsDir, 'electron-main.log');
  // Limit file log level in production; dev keeps default (silly = all levels)
  if (app.isPackaged) {
    log.transports.file.level = 'warn';
    log.transports.console.level = 'warn';
  }
  log.initialize();
  Object.assign(console, log.functions);
  log.errorHandler.startCatching();

  const vcRuntimeOk = await ensureWindowsVCRuntimeInstalled();
  if (!vcRuntimeOk) return;

  // 阻止 macOS App Nap 挂起进程（不阻止屏保，仅保证进程调度持续）
  powerSaveBlocker.start('prevent-app-suspension');

  // macOS: 确保应用有权限激活到前台
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
  }

  // 创建系统托盘（Windows/Linux）或 Dock 菜单（macOS）
  createTray();
  createDockMenu();

  logger.info('calling createWindow');
  await createWindow();
  logger.info('createWindow complete');

  if (app.isPackaged) {
    void desktopUpdateService.checkForUpdates().catch((error) => {
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

  if (!hasCleanedUp) {
    event.preventDefault();
    if (!isCleaningUp) {
      void cleanupAndQuit('will-quit');
    }
  }
});

app.on('before-quit', (event) => {
  logger.info('app before-quit');

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

/**
 * 设置IPC处理器
 */
function setupIpcHandlers() {
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
        const logbookUrl = `http://localhost:5173/logbook.html?${queryString}${authParam}`;
        logger.info(`IPC window:openLogbook loading dev URL: ${logbookUrl}`);
        await logbookWindow.loadURL(logbookUrl);
        logbookWindow.webContents.openDevTools();
      } else {
        // 生产模式：连接内置静态 web 服务
        const fullUrl = `http://127.0.0.1:${selectedWebPort || 5173}/logbook.html?${queryString}${authParam}`;
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
        const spectrumUrl = `http://localhost:5173/spectrum.html${authParam}`;
        logger.info(`IPC window:openSpectrumWindow loading dev URL: ${spectrumUrl}`);
        await spectrumWindow.loadURL(spectrumUrl);
        spectrumWindow.webContents.openDevTools();
      } else {
        const fullUrl = `http://127.0.0.1:${selectedWebPort || 5173}/spectrum.html${authParam}`;
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

  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:quit', async () => {
    await cleanupAndQuit('renderer');
  });
  ipcMain.handle('app:restart', async () => {
    await cleanupAndQuit('renderer', { relaunch: true });
  });

  ipcMain.handle('updater:getStatus', () => {
    return desktopUpdateService.getStatus();
  });

  ipcMain.handle('updater:check', async () => {
    return desktopUpdateService.checkForUpdates();
  });

  ipcMain.handle('updater:openDownload', async (_event, url?: string) => {
    await desktopUpdateService.openDownload(url);
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
let shouldStart = true;

if (!isDevMode) {
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
}

if (shouldStart) {
  logger.info('app startup');
  startApp().catch((err) => logger.error('startApp failed', err));
}
