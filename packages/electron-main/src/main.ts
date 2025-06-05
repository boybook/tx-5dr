const { app, BrowserWindow, Menu } = require('electron');
const { join } = require('path');

async function createWindow() {
  // Start embedded server if requested
  if (process.env.EMBEDDED === 'true') {
    try {
      // This would import and start the server in embedded mode
      // const server = require('@tx5dr/server/dist/server.js');
      console.log('Embedded server placeholder - would start here');
    } catch (error) {
      console.error('Failed to start embedded server:', error);
    }
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
    // 或者可以使用 Menu.setApplicationMenu(null) 来完全移除应用菜单
    // Menu.setApplicationMenu(null);
  }

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
}); 