import { app, BrowserWindow, Menu } from 'electron';
import { join } from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// 获取当前模块的目录（ESM中的__dirname替代方案）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let embeddedServer: any = null;
let serverCheckInterval: any = null;

async function startEmbeddedServer(): Promise<boolean> {
  try {
    console.log('🚀 启动嵌入式服务器...');
    
    // 根据打包状态确定服务器模块路径
    const serverModulePath = app.isPackaged
      ? join(process.resourcesPath, 'app', 'packages', 'server', 'dist', 'server.js')
      : join(__dirname, '../../server/dist/server.js');
    
    const digitalRadioEnginePath = app.isPackaged
      ? join(process.resourcesPath, 'app', 'packages', 'server', 'dist', 'DigitalRadioEngine.js')
      : join(__dirname, '../../server/dist/DigitalRadioEngine.js');

    console.log('🔍 Server module path:', serverModulePath);
    console.log('🔍 DigitalRadioEngine path:', digitalRadioEnginePath);
    
    // 动态导入服务端模块
    const { createServer } = await import(serverModulePath);
    const { DigitalRadioEngine } = await import(digitalRadioEnginePath);
    
    // 创建服务器实例
    embeddedServer = await createServer();
    await embeddedServer.listen({ port: 4000, host: '0.0.0.0' });
    console.log('🚀 TX-5DR server running on http://localhost:4000');
    
    // 启动时钟系统
    const clockManager = DigitalRadioEngine.getInstance();
    console.log('🕐 启动时钟系统进行测试...');
    await clockManager.start();
    console.log('✅ 嵌入式服务器启动完成！');
    
    return true;
  } catch (error) {
    console.error('❌ 嵌入式服务器启动失败:', error);
    console.error('❌ 错误详情:', error);
    return false;
  }
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
        resolve(res.statusCode === 200);
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
  
  // 只在生产模式下清理嵌入式服务器
  if (!isDevelopment && embeddedServer) {
    console.log('🧹 [清理] 正在关闭嵌入式服务器...');
    try {
      embeddedServer.close();
      embeddedServer = null;
      console.log('🧹 [清理] 嵌入式服务器已关闭');
    } catch (error) {
      console.error('❌ [清理] 关闭嵌入式服务器失败:', error);
    }
  } else if (isDevelopment) {
    console.log('🧹 [清理] 开发模式：跳过嵌入式服务器清理');
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
    // 生产模式：启动嵌入式服务器
    console.log('🚀 生产模式：启动嵌入式服务器...');
    const serverStarted = await startEmbeddedServer();
    
    if (!serverStarted) {
      console.error('❌ Failed to start embedded server. Exiting...');
      process.exit(1);
    }
    
    console.log('✅ 嵌入式服务器启动完成！');
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
    // 打包后的路径 - 不使用 asar
    const indexPath = app.isPackaged 
      ? join(process.resourcesPath, 'app', 'packages', 'web', 'dist', 'index.html')
      : join(__dirname, '../../web/dist/index.html');
    console.log('Loading production file:', indexPath);
    try {
      await mainWindow.loadFile(indexPath);
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

// 确保应用总是启动
console.log('🚀 应用启动流程开始...');
startApp().catch(console.error); 