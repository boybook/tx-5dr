/**
 * Electron main process i18n strings.
 * CJK content is allowed here (added to check-i18n allowlist).
 */

export interface ElectronMessages {
  closeWindow: {
    buttons: [string, string, string];
    message: string;
    detail: string;
    checkboxLabel: string;
  };
  vcRuntimeMissing: {
    title: string;
    message: string;
    detail: string;
    buttons: [string, string];
  };
  menu: {
    openMainWindow: string;
    logViewer: string;
    openInBrowser: string;
    quit: string;
  };
}

const ZH: ElectronMessages = {
  closeWindow: {
    buttons: ['最小化到托盘', '退出程序', '取消'],
    message: '关闭主窗口',
    detail: '请选择关闭窗口后的行为：',
    checkboxLabel: '记住我的选择',
  },
  vcRuntimeMissing: {
    title: 'TX-5DR - 缺少运行库',
    message: '检测到当前系统可能缺少 Microsoft Visual C++ 运行库，TX-5DR 启动时可能失败。',
    detail: '建议先安装 Microsoft Visual C++ Redistributable (x64)。你也可以继续尝试启动。下载链接如下：',
    buttons: ['打开下载链接', '继续启动'],
  },
  menu: {
    openMainWindow: '打开主窗口',
    logViewer: '日志查看器',
    openInBrowser: '在浏览器中打开',
    quit: '退出',
  },
};

const EN: ElectronMessages = {
  closeWindow: {
    buttons: ['Minimize to Tray', 'Quit', 'Cancel'],
    message: 'Close Main Window',
    detail: 'Choose what happens when you close the window:',
    checkboxLabel: 'Remember my choice',
  },
  vcRuntimeMissing: {
    title: 'TX-5DR - Missing Runtime',
    message: 'Microsoft Visual C++ Redistributable may be missing, and TX-5DR may fail during startup.',
    detail: 'Installing Microsoft Visual C++ Redistributable (x64) is recommended. You can also continue startup anyway. Download link:',
    buttons: ['Open Download Link', 'Continue Startup'],
  },
  menu: {
    openMainWindow: 'Open Main Window',
    logViewer: 'Log Viewer',
    openInBrowser: 'Open in Browser',
    quit: 'Quit',
  },
};

export function getMessages(locale: string): ElectronMessages {
  return locale.startsWith('zh') ? ZH : EN;
}
