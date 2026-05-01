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
  vcRuntimeOutdated: {
    title: string;
    message: string;
    detail: string;
    buttons: [string, string];
  };
  serverStartupCrash: {
    title: string;
    message: string;
    runtimeHint: string;
    buttons: [string, string];
  };
  httpsSelfSigned: {
    title: string;
    detail: string;
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
  vcRuntimeOutdated: {
    title: 'TX-5DR - 运行库版本过旧',
    message: '检测到当前系统安装的 Microsoft Visual C++ 运行库版本过旧，TX-5DR 需要 2022 或更新版本。',
    detail: '建议下载安装最新的 Microsoft Visual C++ Redistributable (x64)。你也可以继续尝试启动。下载链接如下：',
    buttons: ['打开下载链接', '继续启动'],
  },
  serverStartupCrash: {
    title: 'TX-5DR - Server 启动失败',
    message: 'server 进程启动时异常退出。',
    runtimeHint: '这类问题可能是由于 Microsoft Visual C++ 运行库缺失或版本过旧导致。建议安装或修复最新版 Microsoft Visual C++ Redistributable (x64)，然后重启 TX-5DR。',
    buttons: ['打开 VC++ 运行库下载页面', '关闭'],
  },
  httpsSelfSigned: {
    title: '浏览器可能提示证书不安全',
    detail: '当前浏览器入口使用自签名证书。首次访问时，浏览器可能会提示连接不安全；如果这是你自己的设备，请手动放行后继续访问。',
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
  vcRuntimeOutdated: {
    title: 'TX-5DR - Outdated Runtime',
    message: 'The installed Microsoft Visual C++ Redistributable is too old. TX-5DR requires the 2022 version or newer.',
    detail: 'Please download and install the latest Microsoft Visual C++ Redistributable (x64). You can also continue startup anyway. Download link:',
    buttons: ['Open Download Link', 'Continue Startup'],
  },
  serverStartupCrash: {
    title: 'TX-5DR - Server Startup Failed',
    message: 'The server process exited unexpectedly during startup.',
    runtimeHint: 'This can happen when Microsoft Visual C++ Redistributable is missing or outdated. Please install or repair the latest Microsoft Visual C++ Redistributable (x64), then restart TX-5DR.',
    buttons: ['Open VC++ Runtime Download Page', 'Close'],
  },
  httpsSelfSigned: {
    title: 'Your browser may warn about the certificate',
    detail: 'This browser entrypoint currently uses a self-signed certificate. The first visit may show a security warning; if this is your own device, continue manually after confirming it is expected.',
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
