import { app, BrowserWindow, ipcMain, shell } from 'electron';
import net from 'node:net';
import { join } from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
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
let startupLogs: string[] = []; // 存储启动日志
let errorType: string = 'UNKNOWN'; // 错误类型
let hasStartupError: boolean = false; // 是否发生启动错误
let mainWindowInstance: BrowserWindow | null = null; // 主窗口实例
let logWindowInstance: BrowserWindow | null = null; // 日志窗口实例

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

/**
 * 检测错误类型
 */
function detectError(log: string): string | null {
  const lowerLog = log.toLowerCase();

  // 端口占用
  if (lowerLog.includes('eaddrinuse') || lowerLog.includes('port') && lowerLog.includes('in use')) {
    return 'PORT_IN_USE';
  }

  // 模块缺失
  if (lowerLog.includes('module_not_found') || lowerLog.includes('cannot find module')) {
    return 'MODULE_NOT_FOUND';
  }

  // 权限问题
  if (lowerLog.includes('eacces') || lowerLog.includes('eperm') || lowerLog.includes('permission denied')) {
    return 'PERMISSION_DENIED';
  }

  // 通用错误
  if (lowerLog.includes('error:') || lowerLog.includes('exception') || lowerLog.includes('failed')) {
    return 'UNKNOWN';
  }

  return null;
}

/**
 * 添加日志并检测错误
 */
function addLog(log: string, source: string) {
  const timestamp = new Date().toISOString().substring(11, 19);
  const formattedLog = `[${timestamp}] [${source}] ${log}`;

  console.log('[Electron.addLog] ' + formattedLog);

  startupLogs.push(formattedLog);

  // 限制日志数量，保留最新的 500 条
  if (startupLogs.length > 500) {
    startupLogs = startupLogs.slice(-500);
  }

  // 检测错误
  const detectedError = detectError(log);
  if (detectedError) {
    errorType = detectedError;
    hasStartupError = true;
    console.error(`🚨 检测到启动错误 [${detectedError}]:`, log);
  }

  // 实时推送日志到错误窗口（如果已创建）
  if (logWindowInstance && !logWindowInstance.isDestroyed()) {
    console.log(`正在推送日志到日志窗口: ${formattedLog}`);
    logWindowInstance.webContents.send('log-update', formattedLog);
  } else {
    console.log('窗口还未启动');
  }
}

function runChild(name: string, entryAbs: string, extraEnv: Record<string, string> = {}) {
  const res = resourcesRoot();
  const NODE = nodePath();
  if (!fs.existsSync(NODE)) {
    const errorMsg = `node binary not found: ${NODE}`;
    console.error(`[child:${name}]`, errorMsg);
    addLog(errorMsg, name);
  }
  if (!fs.existsSync(entryAbs)) {
    const errorMsg = `entry not found: ${entryAbs}`;
    console.error(`[child:${name}]`, errorMsg);
    addLog(errorMsg, name);
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

  // 修改 stdio 配置以捕获输出
  const child = spawn(NODE, [entryAbs], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'] // 捕获 stdout 和 stderr
  });

  // 监听 stdout 输出
  if (child.stdout) {
    child.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        console.log(`[child:${name}]`, text);
        text.split('\n').forEach((line: string) => addLog(line, name));
      }
    });
  }

  // 监听 stderr 输出
  if (child.stderr) {
    child.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        console.error(`[child:${name}]`, text);
        text.split('\n').forEach((line: string) => addLog(line, name));
      }
    });
  }

  child.on('exit', (code) => {
    const exitMsg = `exited with code ${code}`;
    console.log(`[child:${name}]`, exitMsg);
    addLog(exitMsg, name);

    // 非零退出码视为错误
    if (code !== 0 && code !== null) {
      errorType = 'CRASH';
      hasStartupError = true;

      // 如果窗口已创建，根据窗口类型处理
      if (mainWindowInstance && !mainWindowInstance.isDestroyed()) {
        const isLogWindow = mainWindowInstance.title?.includes('启动') || mainWindowInstance.title?.includes('正在');
        if (isLogWindow) {
          // 日志窗口：只修改标题
          mainWindowInstance.setTitle('TX-5DR - 启动失败');
        } else {
          // 主窗口：关闭并创建日志窗口
          mainWindowInstance.close();
          void createLogWindow().then(logWin => {
            logWin.setTitle('TX-5DR - 启动失败');
          });
        }
      }
    }
  });

  child.on('error', (err) => {
    const errorMsg = `failed to start: ${err.message}`;
    console.error(`[child:${name}]`, errorMsg);
    addLog(errorMsg, name);
    hasStartupError = true;

    // 如果窗口已创建，根据窗口类型处理
    if (mainWindowInstance && !mainWindowInstance.isDestroyed()) {
      const isLogWindow = mainWindowInstance.title?.includes('启动') || mainWindowInstance.title?.includes('正在');
      if (isLogWindow) {
        // 日志窗口：只修改标题
        mainWindowInstance.setTitle('TX-5DR - 启动失败');
      } else {
        // 主窗口：关闭并创建日志窗口
        mainWindowInstance.close();
        void createLogWindow().then(logWin => {
          logWin.setTitle('TX-5DR - 启动失败');
        });
      }
    }
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
 * 创建日志/启动窗口
 * 启动时立即显示，成功后关闭，失败时保持显示
 */
async function createLogWindow(): Promise<BrowserWindow> {
  if (logWindowInstance) {
    return logWindowInstance;
  }
  console.log('📋 创建日志窗口...');

  const logPagePath = app.isPackaged
    ? `file://${path.join(process.resourcesPath, 'app', 'packages', 'electron-main', 'assets', 'error.html')}`
    : `file://${path.join(__dirname, '..', 'assets', 'error.html')}`;

  const logWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'TX-5DR - 正在启动',
    show: true,  // 立即显示
    titleBarStyle: 'hiddenInset',
    titleBarOverlay: process.platform === 'win32' ? {
      color: '#1a1a2e',
      symbolColor: '#e0e0e0'
    } : false,
    frame: process.platform !== 'darwin',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: app.isPackaged
        ? join(process.resourcesPath, 'app', 'packages', 'electron-main', 'dist', 'preload-error.js')
        : join(__dirname, 'preload-error.js'),
    },
  });

  // 隐藏菜单栏
  if (process.platform === 'win32' || process.platform === 'linux') {
    logWindow.setMenuBarVisibility(false);
  }

  // 立即显示窗口
  logWindow.show();
  logWindow.focus();
  logWindow.moveTop();

  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  }

  // 加载日志页面
  try {
    await logWindow.loadURL(logPagePath);
    console.log('✅ 日志页面加载成功');
  } catch (error) {
    console.error('❌ 加载日志页面失败:', error);
  }

  // 设置为全局实例，以便接收日志更新
  logWindowInstance = logWindow;
  return logWindow;
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
}

async function createWindow() {
  console.log('🔍 createWindow 函数开始执行...');

  // ✅ 第一步：立即创建并显示日志窗口
  const logWindow = await createLogWindow();

  const isDevelopment = process.env.NODE_ENV === 'development' && !app.isPackaged;
  const isPackaged = app.isPackaged;
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
      console.error('❌ 无法连接到外部服务器 (http://localhost:4000)');
      errorType = 'TIMEOUT';
      hasStartupError = true;
      addLog('Development server connection timeout after 30 seconds', 'system');

      // ❌ 失败：修改标题并保持日志窗口显示
      logWindow.setTitle('TX-5DR - 启动失败');
      return logWindow;
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
      console.error('❌ web 服务启动等待超时');
      errorType = 'TIMEOUT';
      hasStartupError = true;
      addLog('web service startup timeout after 15 seconds', 'system');

      // ❌ 失败：修改标题并保持日志窗口显示
      logWindow.setTitle('TX-5DR - 启动失败');
      return logWindow;
    } else {
      console.log('✅ web 服务已就绪');
    }
  }

  // 最后检查：如果子进程已经崩溃
  if (hasStartupError) {
    console.log('🚨 检测到启动错误，保持日志窗口显示');
    logWindow.setTitle('TX-5DR - 启动失败');
    return logWindow;
  }

  // ✅ 成功：关闭日志窗口并创建主窗口
  console.log('✅ 服务启动成功，创建主窗口...');
  setTimeout(() => addLog("✅ 服务启动成功，创建主窗口...", 'main'), 2000);
  if (process.env.NODE_ENV !== 'development') {
    // logWindow.close();
  }

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true, // 立即显示窗口
    titleBarStyle: 'hiddenInset', // macOS 下隐藏标题栏但保留交通灯按钮
    titleBarOverlay: process.platform === 'win32' ? {
      color: '#ffffff',
      symbolColor: '#000000'
    } : false,
    frame: process.platform !== 'darwin', // macOS 下无边框，其他平台保留边框
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // 在开发环境中禁用 web 安全策略
      allowRunningInsecureContent: true,
      // 使用预加载脚本
      preload: app.isPackaged
        ? join(process.resourcesPath, 'app', 'packages', 'electron-preload', 'dist', 'preload.js')
        : join(__dirname, '../../electron-preload/dist/preload.js'),
    },
  });

  // 设置主窗口实例
  mainWindowInstance = mainWindow;

  // 添加错误处理（仅用于运行时错误）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mainWindow.webContents.on('did-fail-load', (_event: any, errorCode: any, errorDescription: any, validatedURL: any) => {
    console.error('Failed to load:', errorCode, errorDescription, validatedURL);
    errorType = 'UNKNOWN';
    hasStartupError = true;
    addLog(`Page load failed: ${errorCode} - ${errorDescription} (${validatedURL})`, 'system');

    // 关闭主窗口并创建日志窗口显示错误
    mainWindow.close();
    void createLogWindow().then(logWin => {
      logWin.setTitle('TX-5DR - 启动失败');
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mainWindow.webContents.on('render-process-gone', (_event: any, details: any) => {
    console.error('Renderer process gone:', details);
  });

  // 添加控制台日志监听
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mainWindow.webContents.on('console-message', (_event: any, level: any, message: any, _line: any, _sourceId: any) => {
    console.log(`Console [${level}]:`, message);
  });

  // 在 Windows 和 Linux 下隐藏菜单栏
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
  }, 10000); // 每10秒检查一次

  // 立即聚焦窗口并激活应用
  console.log('🎉 正在显示和聚焦窗口...');
  mainWindow.show();
  mainWindow.focus();
  mainWindow.moveTop();
  
  // macOS特殊处理：确保应用激活到前台
  if (process.platform === 'darwin') {
    app.focus({ steal: true });
    // 额外的macOS激活步骤
    if (app.dock) {
      app.dock.bounce('critical');
    }
  }

  // Load the app
  if (process.env.NODE_ENV === 'development' && !app.isPackaged) {
    console.log('Loading development URL: http://localhost:5173');
    await mainWindow.loadURL('http://localhost:5173');
  } else {
    // 生产模式：连接内置静态 web 服务（使用上面选择的 webPort）
    const indexPath = `http://127.0.0.1:${selectedWebPort || 5173}`;
    console.log('Loading production URL:', indexPath);
    await mainWindow.loadURL(indexPath);
  }
  
  // 页面加载完成后再次确保聚焦
  mainWindow.once('ready-to-show', () => {
    console.log('🎉 页面加载完成，确保窗口聚焦...');
    mainWindow.show();
    mainWindow.focus();
    mainWindow.moveTop();
    
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
      // 强制将应用带到前台
      app.show();
    }
  });
  
  // 设置IPC处理器
  setupIpcHandlers();
  
  // 确保窗口返回以便后续使用
  console.log('🔍 createWindow 函数准备返回窗口:', mainWindow ? 'BrowserWindow实例' : 'undefined');
  return mainWindow;
}

// 启动应用
const startApp = async () => {
  await app.whenReady();

  console.log("startApp");

  // macOS: 确保应用有权限激活到前台
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
  }

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

  // macOS上通常不在此时退出应用
  if (process.platform !== 'darwin') {
    // 非macOS平台,所有窗口关闭后退出
    void cleanupAndQuit();
  }
});

app.on('activate', () => {
  // macOS: 当点击dock图标时
  if (BrowserWindow.getAllWindows().length === 0) {
    console.log('📱 [应用] activate事件：创建新窗口');
    void createWindow();
  } else {
    // 如果已有窗口，显示并聚焦第一个窗口
    const existingWindow = BrowserWindow.getAllWindows()[0];
    if (existingWindow) {
      console.log('📱 [应用] activate事件：显示现有窗口');
      if (existingWindow.isMinimized()) {
        existingWindow.restore();
      }
      existingWindow.show();
      existingWindow.focus();
    }
  }
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
  // 获取启动日志
  ipcMain.handle('get-startup-logs', async () => {
    console.log('📋 [IPC] 获取启动日志，共', startupLogs.length, '条');
    return startupLogs;
  });

  // 获取错误类型
  ipcMain.handle('get-error-type', async () => {
    console.log('🔍 [IPC] 获取错误类型:', errorType);
    return errorType;
  });

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
        const fullUrl = `http://127.0.0.1:5173/logbook.html?${queryString}`;
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
