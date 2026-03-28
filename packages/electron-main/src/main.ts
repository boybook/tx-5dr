import { app, BrowserWindow, ipcMain, shell, Tray, Menu, dialog, nativeTheme, powerSaveBlocker } from 'electron';
import log from 'electron-log/main';
import { homedir } from 'node:os';
import net from 'node:net';
import { join } from 'path';
import http from 'http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createLogger } from './utils/logger.js';
import { getMessages } from './i18n.js';

// 获取当前模块的目录(ESM中的__dirname替代方案)
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = dirname(__filename);

const logger = createLogger('ElectronMain');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverCheckInterval: any = null;
let serverProcess: import('node:child_process').ChildProcess | null = null;
let webProcess: import('node:child_process').ChildProcess | null = null;
let selectedWebPort: number | null = null;
let selectedServerPort: number | null = null;

// 启动错误跟踪
let errorType: string = ''; // 错误类型，空字符串表示无错误
let hasStartupError: boolean = false; // 是否发生启动错误
let mainWindowInstance: BrowserWindow | null = null; // 主窗口实例
let trayInstance: Tray | null = null; // 系统托盘实例（Windows/Linux）
let isQuitting: boolean = false; // 主动退出标志，防止子进程被杀时弹崩溃错误

// ===== Electron 本地设置 =====
const ELECTRON_SETTINGS_FILE = 'electron-settings.json';

interface ElectronSettings {
  closeBehavior: 'ask' | 'tray' | 'quit';
}

const DEFAULT_ELECTRON_SETTINGS: ElectronSettings = { closeBehavior: 'ask' };

function getElectronSettingsPath(): string {
  return path.join(getAppConfigDir(), ELECTRON_SETTINGS_FILE);
}

function loadElectronSettings(): ElectronSettings {
  try {
    const raw = fs.readFileSync(getElectronSettingsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_ELECTRON_SETTINGS, ...parsed };
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

// no quarantine/permission fallbacks; we assume portable node file is valid

function runChild(name: string, entryAbs: string, extraEnv: Record<string, string> = {}) {
  const res = resourcesRoot();
  const NODE = nodePath();
  if (!fs.existsSync(NODE)) {
    logger.error(`[child:${name}] node binary not found: ${NODE}`);
  }
  if (!fs.existsSync(entryAbs)) {
    logger.error(`[child:${name}] entry not found: ${entryAbs}`);
  }
  const wsjtxPrebuildDir = path.join(res, 'app', 'node_modules', 'wsjtx-lib', 'prebuilds', triplet());
  const env = {
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

  const cwd = path.dirname(entryAbs);

  // 使用 pipe 捕获子进程输出，转发到 electron-log（GUI 模式下 inherit 的输出不可见）
  const child = spawn(NODE, [entryAbs], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 转发子进程 stdout/stderr 到主进程日志
  child.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().trimEnd();
    if (lines) logger.debug(`[child:${name}] ${lines}`);
  });
  child.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().trimEnd();
    if (lines) logger.error(`[child:${name}] ${lines}`);
  });

  child.on('exit', (code, signal) => {
    logger.info(`[child:${name}] exited with code ${code}, signal ${signal}`);

    // 主动退出流程中，子进程被杀是预期行为，不弹错误
    if (isQuitting) return;

    // 非正常退出：非零退出码 或 被信号杀死（code=null, signal='SIGSEGV' 等）
    if (code !== 0) {
      if (!errorType) {
        errorType = 'CRASH';
      }
      hasStartupError = true;
      const logPath = log.transports.file.getFile().path;
      const reason = signal ? `killed by signal ${signal}` : `abnormal exit (code: ${code})`;
      dialog.showErrorBox('TX-5DR - Startup Failed',
        `${name} process ${reason}\n\nLog file: ${logPath}`);
    }
  });

  child.on('error', (err) => {
    logger.error(`[child:${name}] failed to start: ${err.message}`);
    hasStartupError = true;
    const logPath = log.transports.file.getFile().path;
    dialog.showErrorBox('TX-5DR - Startup Failed',
      `${name} process failed to start: ${err.message}\n\nLog file: ${logPath}`);
  });

  return child;
}

// 简单 HTTP 等待
async function waitForHttp(url: string, timeoutMs = 15000, intervalMs = 300): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    function once() {
      try {
        const u = new URL(url);
        const req = http.request(
          { hostname: u.hostname, port: Number(u.port || 80), path: u.pathname, method: 'GET', timeout: 2000 },
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
          void cleanupAndQuit();
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

  const isDevelopment = process.env.NODE_ENV === 'development' && !app.isPackaged;

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
        void cleanupAndQuit();
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
          void cleanupAndQuit();
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mainWindow.webContents.on('did-fail-load', (_event: any, errorCode: any, errorDescription: any, validatedURL: any) => {
    logger.error(`page load failed: ${errorCode} - ${errorDescription} (${validatedURL})`);
    errorType = 'UNKNOWN';
    hasStartupError = true;
    mainWindow.close();
    const logPath = log.transports.file.getFile().path;
    dialog.showErrorBox('TX-5DR - Page Load Failed',
      `Error ${errorCode}: ${errorDescription}\nURL: ${validatedURL}\n\nLog file: ${logPath}`);
  });

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
function openInBrowser() {
  const base = getWebUrl();
  const url = embeddedAdminToken
    ? `${base}?auth_token=${encodeURIComponent(embeddedAdminToken)}`
    : base;
  void shell.openExternal(url);
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

// 清理函数
async function cleanup() {
  const isDevelopment = process.env.NODE_ENV === 'development' && !app.isPackaged;

  // 清理服务器健康检查定时器
  if (serverCheckInterval) {
    clearInterval(serverCheckInterval);
    serverCheckInterval = null;
  }

  // 生产模式：关闭子进程
  if (!isDevelopment) {
    const killProcess = (proc: import('node:child_process').ChildProcess | null, name: string): Promise<void> => {
      return new Promise((resolve) => {
        if (!proc || proc.killed) {
          resolve();
          return;
        }

        logger.info(`stopping child process: ${name} (PID: ${proc.pid})`);

        // 设置超时:如果进程在5秒内没有退出,强制kill
        const timeout = setTimeout(() => {
          if (proc && !proc.killed) {
            logger.warn(`child process ${name} did not exit, force killing`);
            try {
              proc.kill('SIGKILL');
            } catch (err) {
              logger.error(`failed to force kill ${name}`, err);
            }
          }
          resolve();
        }, 5000);

        // 监听进程退出
        proc.once('exit', (code, signal) => {
          clearTimeout(timeout);
          logger.info(`child process ${name} exited (code: ${code}, signal: ${signal})`);
          resolve();
        });

        // 发送SIGTERM信号优雅关闭
        try {
          proc.kill('SIGTERM');
        } catch (err) {
          logger.error(`failed to send SIGTERM to ${name}`, err);
          clearTimeout(timeout);
          resolve();
        }
      });
    };

    // 依次关闭进程
    if (webProcess) {
      await killProcess(webProcess, 'web');
      webProcess = null;
    }
    if (serverProcess) {
      await killProcess(serverProcess, 'server');
      serverProcess = null;
    }
  }

  // 清理系统托盘
  if (trayInstance) {
    trayInstance.destroy();
    trayInstance = null;
  }

  logger.info('cleanup complete');
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
  } else {
    // 生产模式：使用便携 Node 启动子进程（server + web）
    logger.info('production mode: starting child processes with portable Node');
    const res = resourcesRoot();
    const serverEntry = join(res, 'app', 'packages', 'server', 'dist', 'index.js');
    const webEntry = join(res, 'app', 'packages', 'client-tools', 'src', 'proxy.js');

    // 自动端口探测，避免端口占用导致启动失败
    const serverPort = await findFreePort(4000, 50, undefined, '0.0.0.0');
    const webPort = await findFreePort(5173, 50, serverPort, '0.0.0.0'); // 避免和 serverPort 冲突
    selectedServerPort = serverPort;
    selectedWebPort = webPort;

    logger.info(`ports selected: server=${serverPort}, web=${webPort}`);

    serverProcess = runChild('server', serverEntry, {
      PORT: String(serverPort),
      WEB_PORT: String(webPort),
    });
    webProcess = runChild('client-tools', webEntry, {
      PORT: String(webPort),
      STATIC_DIR: join(res, 'app', 'packages', 'web', 'dist'),
      TARGET: `http://127.0.0.1:${serverPort}`,
      // 默认对外开放（监听 0.0.0.0）
      PUBLIC: '1',
    });

    const webOk = await waitForHttp(`http://127.0.0.1:${selectedWebPort}`, 15000, 200);
    if (!webOk) {
      logger.error('web service startup timeout');
      errorType = 'TIMEOUT';
      hasStartupError = true;
      const logPath = log.transports.file.getFile().path;
      dialog.showErrorBox('TX-5DR - Startup Failed',
        `Web service startup timeout\n\nLog file: ${logPath}`);
      return;
    } else {
      logger.info('web service ready');
    }

    // 等待后端服务器 HTTP 就绪
    logger.info('waiting for backend server...');
    const serverOk = await waitForHttp(`http://127.0.0.1:${selectedServerPort}`, 15000, 200);
    if (!serverOk) {
      logger.error('backend server startup timeout');
      errorType = 'TIMEOUT';
      hasStartupError = true;
      const logPath = log.transports.file.getFile().path;
      dialog.showErrorBox('TX-5DR - Startup Failed',
        `Backend server startup timeout\n\nLog file: ${logPath}`);
      return;
    }
    logger.info('backend server ready');
  }

  // 最后检查：如果子进程已经崩溃
  if (hasStartupError) {
    logger.error('startup error detected');
    const logPath = log.transports.file.getFile().path;
    dialog.showErrorBox('TX-5DR - Startup Failed',
      `Error detected during startup (${errorType})\n\nLog file: ${logPath}`);
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
};

// 跟踪清理状态,防止重复清理
let isCleaningUp = false;
let hasCleanedUp = false;

// 统一的清理和退出处理函数
async function cleanupAndQuit() {
  if (hasCleanedUp || isCleaningUp) {
    return;
  }

  isQuitting = true;
  isCleaningUp = true;
  try {
    await cleanup();
    hasCleanedUp = true;
    logger.info('cleanup done, quitting');
  } catch (err) {
    logger.error('cleanup failed', err);
    hasCleanedUp = true;
  } finally {
    isCleaningUp = false;
    app.quit();
  }
}

// 应用退出事件处理
app.on('will-quit', (event) => {
  logger.info('app will-quit');

  // 如果还没有清理完成,阻止退出并执行清理
  if (!hasCleanedUp && !isCleaningUp) {
    event.preventDefault();
    void cleanupAndQuit();
  }
});

app.on('before-quit', (event) => {
  logger.info('app before-quit');
  // 如果还没有清理完成,阻止退出并执行清理
  if (!hasCleanedUp && !isCleaningUp) {
    event.preventDefault();
    void cleanupAndQuit();
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
  void cleanup().then(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  logger.info('received SIGTERM');
  void cleanup().then(() => {
    process.exit(0);
  });
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

  // 配置管理 IPC
  ipcMain.handle('config:get', (_event, key: keyof ElectronSettings) => {
    const settings = loadElectronSettings();
    return settings[key] ?? null;
  });

  ipcMain.handle('config:set', (_event, key: keyof ElectronSettings, value: ElectronSettings[keyof ElectronSettings]) => {
    const settings = loadElectronSettings();
    settings[key] = value;
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
