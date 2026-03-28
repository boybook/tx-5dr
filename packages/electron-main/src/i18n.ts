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
