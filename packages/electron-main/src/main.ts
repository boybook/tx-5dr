import { app, BrowserWindow, ipcMain, shell, Tray, Menu, dialog, nativeTheme } from 'electron';
import log from 'electron-log/main';
import { homedir } from 'node:os';
import net from 'node:net';
import { join } from 'path';
import http from 'http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// 获取当前模块的目录(ESM中的__dirname替代方案)
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = dirname(__filename);

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
    log.error(`[child:${name}] node binary not found: ${NODE}`);
  }
  if (!fs.existsSync(entryAbs)) {
    log.error(`[child:${name}] entry not found: ${entryAbs}`);
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
    if (lines) log.info(`[child:${name}] ${lines}`);
  });
  child.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().trimEnd();
    if (lines) log.error(`[child:${name}] ${lines}`);
  });

  child.on('exit', (code, signal) => {
    log.info(`[child:${name}] exited with code ${code}, signal ${signal}`);

    // 非正常退出：非零退出码 或 被信号杀死（code=null, signal='SIGSEGV' 等）
    if (code !== 0) {
      if (!errorType) {
        errorType = 'CRASH';
      }
      hasStartupError = true;
      const logPath = log.transports.file.getFile().path;
      const reason = signal ? `被信号 ${signal} 终止` : `异常退出 (code: ${code})`;
      dialog.showErrorBox('TX-5DR - 启动失败',
        `${name} 进程${reason}\n\n详细日志: ${logPath}`);
    }
  });

  child.on('error', (err) => {
    log.error(`[child:${name}] failed to start: ${err.message}`);
    hasStartupError = true;
    const logPath = log.transports.file.getFile().path;
    dialog.showErrorBox('TX-5DR - 启动失败',
      `${name} 进程启动失败: ${err.message}\n\n详细日志: ${logPath}`);
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
  const template: Parameters<typeof Menu.buildFromTemplate>[0] = [
    { label: '打开主窗口', click: () => showMainWindow() },
    { label: '日志查看器', click: () => openLogInTerminal() },
    { type: 'separator' },
    { label: '在浏览器中打开', click: () => openInBrowser() },
  ];

  if (includQuit) {
    template.push(
      { type: 'separator' },
      {
        label: '退出',
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
        ? path.join(process.resourcesPath, 'app', 'packages', 'electron-main', 'assets', 'icon.ico')
        : path.join(__dirname, '..', 'assets', 'icon.ico'))
    : (app.isPackaged
        ? path.join(process.resourcesPath, 'app', 'packages', 'electron-main', 'assets', 'icon.png')
        : path.join(__dirname, '..', 'assets', 'icon.png'));

  trayInstance = new Tray(iconPath);
  trayInstance.setToolTip('TX-5DR 数字电台');
  trayInstance.setContextMenu(buildContextMenu(true));

  // 双击托盘图标打开主窗口（Windows 惯例）
  trayInstance.on('double-click', () => {
    showMainWindow();
  });

  console.log('🔔 系统托盘已创建');
}

/**
 * 创建 macOS Dock 菜单
 */
function createDockMenu() {
  if (process.platform !== 'darwin') return;
  if (!app.dock) return;

  // Dock 菜单不含"退出"（macOS 有标准退出方式 Cmd+Q）
  app.dock.setMenu(buildContextMenu(false));
  console.log('🍎 Dock 菜单已创建');
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
      preload: app.isPackaged
        ? join(process.resourcesPath, 'app', 'packages', 'electron-preload', 'dist', 'preload.js')
        : join(__dirname, '../../electron-preload/dist/preload.js'),
    },
  });

  mainWindowInstance = mainWindow;

  mainWindow.on('closed', () => {
    console.log('🪟 主窗口已关闭，清理实例引用');
    mainWindowInstance = null;
    if (serverCheckInterval) {
      clearInterval(serverCheckInterval);
      serverCheckInterval = null;
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mainWindow.webContents.on('did-fail-load', (_event: any, errorCode: any, errorDescription: any, validatedURL: any) => {
    log.error('Failed to load:', errorCode, errorDescription, validatedURL);
    errorType = 'UNKNOWN';
    hasStartupError = true;
    log.error(`[system] Page load failed: ${errorCode} - ${errorDescription} (${validatedURL})`);
    mainWindow.close();
    const logPath = log.transports.file.getFile().path;
    dialog.showErrorBox('TX-5DR - 页面加载失败',
      `错误 ${errorCode}: ${errorDescription}\nURL: ${validatedURL}\n\n详细日志: ${logPath}`);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mainWindow.webContents.on('render-process-gone', (_event: any, details: any) => {
    console.error('Renderer process gone:', details);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mainWindow.webContents.on('console-message', (_event: any, level: any, message: any, _line: any, _sourceId: any) => {
    console.log(`Console [${level}]:`, message);
  });

  if (process.platform === 'win32' || process.platform === 'linux') {
    mainWindow.setMenuBarVisibility(false);
  }

  // 定期检查服务器健康状态
  serverCheckInterval = setInterval(async () => {
    const isHealthy = await checkServerHealth();
    if (!isHealthy) {
      if (isDevelopment) {
        console.log('⚠️ 外部服务器连接丢失 (开发模式)');
      } else {
        console.log('⚠️ 嵌入式服务器连接丢失');
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

  // 导航到前端服务页面（加载完成后自然替换 loading 页面）
  const webUrl = getWebUrl();
  console.log('Loading URL:', webUrl);
  await mainWindow.loadURL(webUrl);

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
  log.info(`在原生终端中打开日志: ${logDir}`);

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
        `echo "TX-5DR 日志查看器"`,
        `echo "日志目录: ${logDir}"`,
        `echo "监控文件: ${logFiles.map(f => path.basename(f)).join(', ')}"`,
        `echo "按 Ctrl+C 退出"`,
        `echo ""`,
        `tail -f ${tailTarget}`,
      ].join('\n'), { mode: 0o755 });
      spawn('open', ['-a', 'Terminal', script]);
    } else if (process.platform === 'win32') {
      // Windows: PowerShell 的 Get-Content 支持多文件
      const psFiles = logFiles.map(f => `'${f}'`).join(', ');
      spawn('cmd', ['/c', 'start', 'cmd', '/k',
        `title TX-5DR 日志查看器 && powershell -Command "Get-Content ${psFiles} -Wait -Tail 50"`
      ], { shell: true });
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
        log.warn('未找到可用终端模拟器');
        dialog.showErrorBox('TX-5DR', `未找到终端模拟器\n\n日志目录: ${logDir}`);
      }
    }
  } catch (err) {
    log.error('打开终端失败:', err);
    dialog.showErrorBox('TX-5DR', `打开终端失败\n\n日志目录: ${logDir}`);
  }
}

/**
 * 在系统浏览器中打开 web 界面
 */
function openInBrowser() {
  void shell.openExternal(getWebUrl());
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
    
    console.log('🩺 [健康检查] 正在连接 http://localhost:4000/...');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = http.request(options, (res: any) => {
      console.log(`🩺 [健康检查] 收到响应，状态码: ${res.statusCode}`);

      let data = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res.on('data', (chunk: any) => {
        data += chunk;
      });

      res.on('end', () => {
        console.log(`🩺 [健康检查] 响应数据: ${data}`);
        resolve((res.statusCode || 0) < 500);
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    req.on('error', (err: any) => {
      console.log(`🩺 [健康检查] 连接错误: ${err.message}`);
      resolve(false);
    });
    
    req.on('timeout', () => {
      console.log('🩺 [健康检查] 连接超时');
      resolve(false);
    });
    
    req.end();
  });
}

// 清理函数
async function cleanup() {
  console.log('🧹 [清理] 正在清理资源...');

  const isDevelopment = process.env.NODE_ENV === 'development' && !app.isPackaged;

  // 清理服务器健康检查定时器
  if (serverCheckInterval) {
    clearInterval(serverCheckInterval);
    serverCheckInterval = null;
    console.log('🧹 [清理] 已清理健康检查定时器');
  }

  // 生产模式：关闭子进程
  if (!isDevelopment) {
    const killProcess = (proc: import('node:child_process').ChildProcess | null, name: string): Promise<void> => {
      return new Promise((resolve) => {
        if (!proc || proc.killed) {
          resolve();
          return;
        }

        console.log(`🧹 [清理] 正在关闭 ${name} 子进程 (PID: ${proc.pid})...`);

        // 设置超时:如果进程在5秒内没有退出,强制kill
        const timeout = setTimeout(() => {
          if (proc && !proc.killed) {
            console.log(`🧹 [清理] ${name} 进程未响应,强制终止...`);
            try {
              proc.kill('SIGKILL');
            } catch (err) {
              console.error(`🧹 [清理] 强制终止 ${name} 进程失败:`, err);
            }
          }
          resolve();
        }, 5000);

        // 监听进程退出
        proc.once('exit', (code, signal) => {
          clearTimeout(timeout);
          console.log(`🧹 [清理] ${name} 子进程已退出 (code: ${code}, signal: ${signal})`);
          resolve();
        });

        // 发送SIGTERM信号优雅关闭
        try {
          proc.kill('SIGTERM');
        } catch (err) {
          console.error(`🧹 [清理] 发送SIGTERM到 ${name} 进程失败:`, err);
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

    console.log('🧹 [清理] 所有子进程已关闭');
  } else {
    console.log('🧹 [清理] 开发模式：无子进程可清理');
  }

  // 清理系统托盘
  if (trayInstance) {
    trayInstance.destroy();
    trayInstance = null;
    console.log('🧹 [清理] 已清理系统托盘');
  }

}

async function createWindow() {
  console.log('🔍 createWindow 函数开始执行...');

  // 检查主窗口是否已存在且有效
  if (mainWindowInstance && !mainWindowInstance.isDestroyed()) {
    console.log('🪟 主窗口已存在，复用现有窗口');
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
  console.log('🔄 启动状态已重置');

  // 日志窗口不再在启动时自动显示，仅在出错时创建

  const isDevelopment = process.env.NODE_ENV === 'development' && !app.isPackaged;
  console.log('🔍 isDevelopment:', isDevelopment);

  if (isDevelopment) {
    console.log('🛠️ 开发模式：使用外部服务器 (http://localhost:4000)');
    console.log('📋 请确保已经启动开发服务器：yarn dev');

    // 在开发模式下，等待外部服务器准备就绪
    console.log('⏳ 等待外部服务器启动...');
    let serverReady = false;
    for (let i = 0; i < 30; i++) { // 最多等待30秒
      serverReady = await checkServerHealth();
      if (serverReady) break;
      console.log(`⏳ 等待外部服务器... (${i + 1}/30)`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!serverReady) {
      log.error('无法连接到外部服务器 (http://localhost:4000)');
      errorType = 'TIMEOUT';
      hasStartupError = true;
      log.error('[system] Development server connection timeout after 30 seconds');
      const logPath = log.transports.file.getFile().path;
      dialog.showErrorBox('TX-5DR - 启动失败',
        `无法连接到开发服务器 (http://localhost:4000)\n请确保已运行 yarn dev\n\n详细日志: ${logPath}`);
      return;
    }

    console.log('✅ 外部服务器连接成功！');
  } else {
    // 生产模式：使用便携 Node 启动子进程（server + web）
    console.log('🚀 生产模式：使用便携 Node 启动子进程...');
    const res = resourcesRoot();
    const serverEntry = join(res, 'app', 'packages', 'server', 'dist', 'index.js');
    const webEntry = join(res, 'app', 'packages', 'client-tools', 'src', 'proxy.js');

    // 自动端口探测，避免端口占用导致启动失败
    const serverPort = await findFreePort(4000, 50, undefined, '0.0.0.0');
    const webPort = await findFreePort(5173, 50, serverPort, '0.0.0.0'); // 避免和 serverPort 冲突
    selectedServerPort = serverPort;
    selectedWebPort = webPort;

    console.log(`🔎 端口选择：server=${serverPort}, web=${webPort}`);

    serverProcess = runChild('server', serverEntry, { PORT: String(serverPort) });
    webProcess = runChild('client-tools', webEntry, {
      PORT: String(webPort),
      STATIC_DIR: join(res, 'app', 'packages', 'web', 'dist'),
      TARGET: `http://127.0.0.1:${serverPort}`,
      // 默认对外开放（监听 0.0.0.0）
      PUBLIC: '1',
    });

    const webOk = await waitForHttp(`http://127.0.0.1:${selectedWebPort}`);
    if (!webOk) {
      log.error('web 服务启动等待超时');
      errorType = 'TIMEOUT';
      hasStartupError = true;
      log.error('[system] web service startup timeout after 15 seconds');
      const logPath = log.transports.file.getFile().path;
      dialog.showErrorBox('TX-5DR - 启动失败',
        `Web 服务启动超时\n\n详细日志: ${logPath}`);
      return;
    } else {
      console.log('✅ web 服务已就绪');
    }
  }

  // 最后检查：如果子进程已经崩溃
  if (hasStartupError) {
    log.error('检测到启动错误');
    const logPath = log.transports.file.getFile().path;
    dialog.showErrorBox('TX-5DR - 启动失败',
      `启动过程中检测到错误 (${errorType})\n\n详细日志: ${logPath}`);
    return;
  }

  // ✅ 成功：直接创建主窗口
  console.log('✅ 服务启动成功，创建主窗口...');
  return createMainWindowOnly();
}

// 启动应用
const startApp = async () => {
  await app.whenReady();

  console.log("startApp");

  // 初始化 electron-log：统一日志目录到与 server AppPaths 一致的位置
  // macOS: ~/Library/Logs/TX-5DR/, Windows: %LOCALAPPDATA%\TX-5DR\logs\, Linux: ~/.local/share/TX-5DR/logs/
  const APP_NAME = 'TX-5DR';
  const logsDir = process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Logs', APP_NAME)
    : process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), APP_NAME, 'logs')
      : path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), APP_NAME, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  log.transports.file.resolvePathFn = () => path.join(logsDir, 'electron-main.log');
  log.initialize();
  Object.assign(console, log.functions);
  log.errorHandler.startCatching();

  // macOS: 确保应用有权限激活到前台
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
  }

  // 创建系统托盘（Windows/Linux）或 Dock 菜单（macOS）
  createTray();
  createDockMenu();

  console.log('🔍 正在调用 createWindow...');
  await createWindow();
  console.log('✅ createWindow 完成');
};

// 跟踪清理状态,防止重复清理
let isCleaningUp = false;
let hasCleanedUp = false;

// 统一的清理和退出处理函数
async function cleanupAndQuit() {
  if (hasCleanedUp || isCleaningUp) {
    return;
  }

  isCleaningUp = true;
  try {
    await cleanup();
    hasCleanedUp = true;
    console.log('📱 [应用] 清理完成,正在退出...');
  } catch (err) {
    console.error('📱 [应用] 清理失败:', err);
    hasCleanedUp = true;
  } finally {
    isCleaningUp = false;
    app.quit();
  }
}

// 应用退出事件处理
app.on('will-quit', (event) => {
  console.log('📱 [应用] 即将退出 (will-quit)...');

  // 如果还没有清理完成,阻止退出并执行清理
  if (!hasCleanedUp && !isCleaningUp) {
    event.preventDefault();
    void cleanupAndQuit();
  }
});

app.on('before-quit', (event) => {
  console.log('📱 [应用] 准备退出 (before-quit)...');
  // 如果还没有清理完成,阻止退出并执行清理
  if (!hasCleanedUp && !isCleaningUp) {
    event.preventDefault();
    void cleanupAndQuit();
  }
});

app.on('window-all-closed', () => {
  console.log('📱 [应用] 所有窗口已关闭');
  // 所有平台都不在此退出，通过托盘/Dock菜单的"退出"来真正退出
  // Windows/Linux 有托盘常驻，macOS 有 Dock 常驻
});

app.on('activate', () => {
  // macOS: 当点击dock图标时，恢复或创建主窗口
  showMainWindow();
});

// 处理进程退出信号
process.on('SIGINT', () => {
  console.log('📱 [进程] 收到 SIGINT 信号');
  void cleanup().then(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('📱 [进程] 收到 SIGTERM 信号');
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
    console.log('📖 [IPC] 收到打开通联日志窗口请求:', queryString);
    
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
          preload: app.isPackaged
            ? join(process.resourcesPath, 'app', 'packages', 'electron-preload', 'dist', 'preload.js')
            : join(__dirname, '../../electron-preload/dist/preload.js'),
        },
      });

      // 在 Windows 和 Linux 下隐藏菜单栏
      if (process.platform === 'win32' || process.platform === 'linux') {
        logbookWindow.setMenuBarVisibility(false);
      }

      // 加载通联日志页面
      if (process.env.NODE_ENV === 'development' && !app.isPackaged) {
        // 开发模式：使用 Vite
        const logbookUrl = `http://localhost:5173/logbook.html?${queryString}`;
        console.log('📖 [IPC] 加载开发URL:', logbookUrl);
        await logbookWindow.loadURL(logbookUrl);
        logbookWindow.webContents.openDevTools();
      } else {
        // 生产模式：连接内置静态 web 服务
        const fullUrl = `http://127.0.0.1:${selectedWebPort || 5173}/logbook.html?${queryString}`;
        console.log('📖 [IPC] 加载生产URL:', fullUrl);
        await logbookWindow.loadURL(fullUrl);
      }

      // 聚焦新窗口
      logbookWindow.focus();
      
      console.log('✅ [IPC] 通联日志窗口创建成功');
    } catch (error) {
      console.error('❌ [IPC] 创建通联日志窗口失败:', error);
      throw error;
    }
  });

  // 处理打开目录的请求（在系统文件管理器中打开）
  ipcMain.handle('shell:openPath', async (_event, dirPath: string) => {
    console.log('📁 [IPC] 收到打开目录请求:', dirPath);

    try {
      // 验证路径存在
      if (!fs.existsSync(dirPath)) {
        // 尝试创建目录
        fs.mkdirSync(dirPath, { recursive: true });
      }

      // 使用系统文件管理器打开目录
      const result = await shell.openPath(dirPath);
      if (result) {
        console.error('❌ [IPC] 打开目录失败:', result);
        throw new Error(result);
      }
      console.log('✅ [IPC] 目录打开成功');
      return result;
    } catch (error) {
      console.error('❌ [IPC] 打开目录失败:', error);
      throw error;
    }
  });

  // 处理打开外部链接的请求
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    console.log('🔗 [IPC] 收到打开外部链接请求:', url);
    
    try {
      // 验证URL格式
      const urlObj = new URL(url);
      
      // 只允许http和https协议
      if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
        throw new Error(`不安全的协议: ${urlObj.protocol}`);
      }
      
      // 使用系统默认浏览器打开链接
      await shell.openExternal(url);
      console.log('✅ [IPC] 外部链接打开成功');
    } catch (error) {
      console.error('❌ [IPC] 打开外部链接失败:', error);
      throw error;
    }
  });
}

// 确保应用总是启动
console.log('🚀 应用启动流程开始...');
startApp().catch(console.error); 
