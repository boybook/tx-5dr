// 完全使用 CommonJS 模式
const { app, BrowserWindow, Menu } = require('electron');
const { join, resolve } = require('path');
const { spawn } = require('child_process');

let serverProcess: any = null;
let serverCheckInterval: any = null;

async function checkServerHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const http = require('http');
    const options = {
      hostname: '127.0.0.1', // 明确使用 IPv4
      port: 4000,
      path: '/',
      method: 'GET',
      timeout: 2000
    };
    
    // 只在服务器进程存在时输出调试信息
    if (serverProcess && !serverProcess.killed) {
      console.log('🩺 [健康检查] 正在连接 http://localhost:4000/...');
    }
    
    const req = http.request(options, (res: any) => {
      if (serverProcess && !serverProcess.killed) {
        console.log(`🩺 [健康检查] 收到响应，状态码: ${res.statusCode}`);
      }
      
      let data = '';
      res.on('data', (chunk: any) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (serverProcess && !serverProcess.killed) {
          console.log(`🩺 [健康检查] 响应数据: ${data}`);
        }
        resolve(res.statusCode === 200);
      });
    });
    
    req.on('error', (err: any) => {
      if (serverProcess && !serverProcess.killed) {
        console.log(`🩺 [健康检查] 连接错误: ${err.message}`);
      }
      resolve(false);
    });
    
    req.on('timeout', () => {
      if (serverProcess && !serverProcess.killed) {
        console.log('🩺 [健康检查] 连接超时');
      }
      resolve(false);
    });
    
    req.end();
  });
}

async function waitForServerOrStart() {
  if (process.env.EMBEDDED === 'true') {
    console.log('🚀 Starting embedded TX-5DR server...');
    
    // 启动服务器进程（保存进程引用）
    serverProcess = spawn('yarn', ['workspace', '@tx5dr/server', 'start'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'production'
      }
    });

    // 监听服务器进程事件
    serverProcess.on('close', (code: number) => {
      console.log(`📡 [服务器进程] 进程退出，代码: ${code}`);
      serverProcess = null;
    });

    serverProcess.on('error', (error: Error) => {
      console.error('❌ [服务器进程] 启动失败:', error);
      serverProcess = null;
    });

    console.log('🚀 Embedded server is starting...');
    
    // 等待服务器真正启动完成
    return new Promise<boolean>((resolve) => {
      let attempts = 0;
      const maxAttempts = 60; // 60秒超时
      
      // 延迟3秒开始检查，给服务器更多启动时间
      setTimeout(async () => {
        const checkInterval = setInterval(async () => {
          // 如果服务器进程已经退出，返回失败
          if (!serverProcess || serverProcess.killed) {
            console.log('❌ [嵌入式服务器] 服务器进程意外退出');
            clearInterval(checkInterval);
            resolve(false);
            return;
          }
          
          attempts++;
          console.log(`🔍 [嵌入式服务器] 健康检查 ${attempts}/${maxAttempts}...`);
          
          const isHealthy = await checkServerHealth();
          if (isHealthy) {
            console.log(`✅ TX-5DR embedded server is ready! (took ${attempts} seconds)`);
            clearInterval(checkInterval);
            resolve(true);
          } else if (attempts >= maxAttempts) {
            console.error('❌ Embedded server failed to start within 60 seconds');
            clearInterval(checkInterval);
            resolve(false);
          } else {
            console.log(`⏳ Waiting for embedded server... (${attempts}/${maxAttempts})`);
          }
        }, 1000);
      }, 3000);
    });
  } else {
    // 检查服务器是否已经运行
    console.log('🔍 [外部服务器] 检查服务器是否已经运行...');
    const isHealthy = await checkServerHealth();
    if (isHealthy) {
      console.log('✅ TX-5DR server is already running!');
      return true;
    } else {
      console.log('⚠️ TX-5DR server is not running. Please start it manually with:');
      console.log('   yarn workspace @tx5dr/server dev');
      return false;
    }
  }
}

// 清理函数
function cleanup() {
  console.log('🧹 [清理] 正在清理资源...');
  
  // 清理常规服务器健康检查定时器
  if (serverCheckInterval) {
    clearInterval(serverCheckInterval);
    serverCheckInterval = null;
    console.log('🧹 [清理] 已清理常规健康检查定时器');
  }
  
  // 清理服务器进程
  if (serverProcess && !serverProcess.killed) {
    console.log('🧹 [清理] 正在终止服务器进程...');
    try {
      // 先尝试优雅关闭
      serverProcess.kill('SIGTERM');
      
      // 如果3秒后还没关闭，强制终止
      setTimeout(() => {
        if (serverProcess && !serverProcess.killed) {
          console.log('🧹 [清理] 强制终止服务器进程');
          serverProcess.kill('SIGKILL');
        }
      }, 3000);
    } catch (error) {
      console.error('❌ [清理] 终止服务器进程失败:', error);
    }
  }
}

async function createWindow() {
  // 检查或启动服务器
  const serverReady = await waitForServerOrStart();
  
  if (!serverReady) {
    if (process.env.EMBEDDED === 'true') {
      console.error('❌ Failed to start embedded server. Exiting...');
      process.exit(1);
    } else {
      console.log('📱 Opening app anyway - you can start the server later');
    }
  } else {
    console.log('🎉 Server is ready! Creating application window...');
  }

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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
      // 暂时注释掉预加载脚本
      // preload: join(__dirname, '../../electron-preload/dist/preload.js'),
    },
  });

  // 添加错误处理
  mainWindow.webContents.on('did-fail-load', (event: any, errorCode: any, errorDescription: any, validatedURL: any) => {
    console.error('Failed to load:', errorCode, errorDescription, validatedURL);
  });

  mainWindow.webContents.on('crashed', (event: any, killed: any) => {
    console.error('Renderer process crashed:', killed);
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
      console.log('⚠️ Server connection lost');
  }
  }, 10000); // 每10秒检查一次

  // Load the app
  if (process.env.NODE_ENV === 'development') {
    console.log('Loading development URL: http://localhost:5173');
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    const indexPath = join(__dirname, '../../web/dist/index.html');
    console.log('Loading production file:', indexPath);
    await mainWindow.loadFile(indexPath);
  }
}

// 启动应用
const startApp = async () => {
  await app.whenReady();
  await createWindow();
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
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
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

// 如果直接运行此文件，启动应用
if (require.main === module) {
  startApp().catch(console.error);
} 