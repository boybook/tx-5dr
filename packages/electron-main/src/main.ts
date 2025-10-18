import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron';
import { join } from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// 获取当前模块的目录（ESM中的__dirname替代方案）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let serverCheckInterval: any = null;
let serverProcess: import('node:child_process').ChildProcess | null = null;
let webProcess: import('node:child_process').ChildProcess | null = null;

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
    console.error(`[child:${name}] node binary not found:`, NODE);
  }
  if (!fs.existsSync(entryAbs)) {
    console.error(`[child:${name}] entry not found:`, entryAbs);
  }
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    APP_RESOURCES: res,
    // 明确为子进程提供模块解析路径，确保能解析到 app/node_modules
    NODE_PATH: path.join(res, 'app', 'node_modules'),
    ...(process.platform === 'win32'
      ? { PATH: `${process.env.PATH};${path.join(res, 'app', 'native')}` }
      : { LD_LIBRARY_PATH: `${path.join(res, 'app', 'native')}:${process.env.LD_LIBRARY_PATH || ''}` }),
    ...extraEnv,
  } as NodeJS.ProcessEnv;

  const cwd = path.dirname(entryAbs);
  const child = spawn(NODE, [entryAbs], { cwd, env, stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log(`[child:${name}] exited with code`, code);
  });
  child.on('error', (err) => {
    console.error(`[child:${name}] failed to start:`, err);
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

async function checkServerHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const options = {
      hostname: '127.0.0.1', // 明确使用 IPv4
      port: 4000,
      path: '/',
      method: 'GET',
      timeout: 2000
    };
    
    console.log('🩺 [健康检查] 正在连接 http://localhost:4000/...');
    
    const req = http.request(options, (res: any) => {
      console.log(`🩺 [健康检查] 收到响应，状态码: ${res.statusCode}`);
      
      let data = '';
      res.on('data', (chunk: any) => {
        data += chunk;
      });
      
      res.on('end', () => {
        console.log(`🩺 [健康检查] 响应数据: ${data}`);
        resolve((res.statusCode || 0) < 500);
      });
    });
    
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
function cleanup() {
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
    if (webProcess && !webProcess.killed) {
      console.log('🧹 [清理] 关闭 web 子进程');
      try { webProcess.kill(); } catch {}
      webProcess = null;
    }
    if (serverProcess && !serverProcess.killed) {
      console.log('🧹 [清理] 关闭 server 子进程');
      try { serverProcess.kill(); } catch {}
      serverProcess = null;
    }
  } else {
    console.log('🧹 [清理] 开发模式：无子进程可清理');
  }
}

async function createWindow() {
  console.log('🔍 createWindow 函数开始执行...');
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
      console.error('❌ 无法连接到外部服务器 (http://localhost:4000)');
      console.error('💡 请先启动开发服务器：yarn dev');
      process.exit(1);
    }
    
    console.log('✅ 外部服务器连接成功！');
  } else {
    // 生产模式：使用便携 Node 启动子进程（server + web）
    console.log('🚀 生产模式：使用便携 Node 启动子进程...');
    const res = resourcesRoot();
    const serverEntry = join(res, 'app', 'packages', 'server', 'dist', 'index.js');
    const webEntry = join(res, 'app', 'packages', 'client-tools', 'src', 'proxy.js');

    serverProcess = runChild('server', serverEntry, { PORT: '4000' });
    webProcess = runChild('client-tools', webEntry, {
      PORT: '5173',
      STATIC_DIR: join(res, 'app', 'packages', 'web', 'dist'),
      TARGET: 'http://127.0.0.1:4000',
      // 默认对外开放（监听 0.0.0.0）
      PUBLIC: '1',
    });

    const webOk = await waitForHttp('http://127.0.0.1:5173');
    if (!webOk) {
      console.warn('⚠️ web 服务启动等待超时');
    } else {
      console.log('✅ web 服务已就绪');
    }
  }

  console.log('🎉 Server is ready! Creating application window...');

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

  // 添加错误处理
  mainWindow.webContents.on('did-fail-load', (event: any, errorCode: any, errorDescription: any, validatedURL: any) => {
    console.error('Failed to load:', errorCode, errorDescription, validatedURL);
  });

  mainWindow.webContents.on('render-process-gone', (event: any, details: any) => {
    console.error('Renderer process gone:', details);
  });

  // 添加控制台日志监听
  mainWindow.webContents.on('console-message', (event: any, level: any, message: any, line: any, sourceId: any) => {
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
    try {
      await mainWindow.loadURL('http://localhost:5173');
      if (isDevelopment) {
        mainWindow.webContents.openDevTools();
      }
    } catch (error) {
      console.error('❌ 加载开发页面失败:', error);
    }
  } else {
    // 生产模式：连接内置静态 web 服务
    const indexPath = 'http://127.0.0.1:5173';
    console.log('Loading production URL:', indexPath);
    try {
      await mainWindow.loadURL(indexPath);
    } catch (error) {
      console.error('❌ 加载生产页面失败:', error);
    }
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
  
  // macOS: 确保应用有权限激活到前台
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
  }
  
  console.log('🔍 正在调用 createWindow...');
  const window = await createWindow();
  console.log('🔍 createWindow 返回值:', window ? 'BrowserWindow实例' : 'undefined或null');
  
  // 创建窗口后额外确保显示和聚焦
  setTimeout(() => {
    if (window && !window.isDestroyed()) {
      console.log('🔄 额外聚焦检查...');
      window.show();
      window.focus();
      window.moveTop();
      
      if (process.platform === 'darwin') {
        app.focus({ steal: true });
        app.show();
        // 多次尝试确保窗口显示
        setTimeout(() => {
          if (!window.isDestroyed()) {
            window.show();
            window.focus();
          }
        }, 100);
      }
    } else {
      console.log('⚠️ 窗口为空或已销毁，无法进行额外聚焦');
    }
  }, 500); // 延迟500ms确保所有初始化完成
};

// 应用退出事件处理
app.on('before-quit', (event: any) => {
  console.log('📱 [应用] 准备退出...');
  cleanup();
});

app.on('window-all-closed', () => {
  console.log('📱 [应用] 所有窗口已关闭');
  cleanup();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // macOS: 当点击dock图标时
  if (BrowserWindow.getAllWindows().length === 0) {
    console.log('📱 [应用] activate事件：创建新窗口');
    createWindow();
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
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('📱 [进程] 收到 SIGTERM 信号');
  cleanup();
  process.exit(0);
});

/**
 * 设置IPC处理器
 */
function setupIpcHandlers() {
  // 处理打开通联日志窗口的请求
  ipcMain.handle('window:openLogbook', async (event, queryString: string) => {
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
  ipcMain.handle('shell:openExternal', async (event, url: string) => {
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
