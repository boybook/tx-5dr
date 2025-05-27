const { contextBridge } = require('electron');

// 简单的预加载脚本，暴露一些基本的 API
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  version: process.version,
  // 可以在这里添加更多安全的 API
}); 