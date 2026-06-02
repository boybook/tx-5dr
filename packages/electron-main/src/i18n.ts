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
  startupErrors: {
    logHint: string;
    actions: {
      'open-vc-runtime-download': string;
    };
    vc_runtime: {
      title: string;
      message: string;
      detail: string;
    };
    server_timeout: {
      title: string;
      message: string;
      detail: string;
    };
    web_timeout: {
      title: string;
      message: string;
      detail: string;
    };
    port_conflict: {
      title: string;
      message: string;
      detail: string;
    };
    native_module: {
      title: string;
      message: string;
      detail: string;
    };
    child_crash: {
      title: string;
      message: string;
      detail: string;
    };
    child_start_failed: {
      title: string;
      message: string;
      detail: string;
    };
    unknown: {
      title: string;
      message: string;
      detail: string;
    };
    devBackendHint: string;
    devFrontendHint: string;
    realtimeFallbackHint: string;
    testHint: string;
  };
  httpsSelfSigned: {
    title: string;
    detail: string;
  };
  menu: {
    openMainWindow: string;
    openDevTools: string;
    logViewer: string;
    openInBrowser: string;
    about: string;
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
  startupErrors: {
    logHint: '你可以查看下方实时日志，或点击日志区域右上角的文件夹图标打开日志目录。',
    actions: {
      'open-vc-runtime-download': '下载 VC++ 运行库',
    },
    vc_runtime: {
      title: '需要安装 VC++ 运行库',
      message: 'TX-5DR 需要 Microsoft Visual C++ Redistributable (x64) 才能完整启动。',
      detail: '请点击下方按钮下载并安装运行库，安装完成后重新启动 TX-5DR。',
    },
    server_timeout: {
      title: '后端服务未能启动',
      message: 'TX-5DR 已启动窗口，但后端服务没有在预期时间内准备完成。',
      detail: '请稍后重启应用；如果问题持续出现，请根据下方日志中的错误信息排查。',
    },
    web_timeout: {
      title: '界面服务未能启动',
      message: '本地界面服务没有在预期时间内准备完成，因此暂时无法进入主界面。',
      detail: '请确认本机资源和端口没有被其他程序占用，然后重启应用。',
    },
    port_conflict: {
      title: '启动端口被占用',
      message: 'TX-5DR 无法找到可用的本地端口来启动内置服务。',
      detail: '请关闭可能占用相关端口的程序，或稍后重启 TX-5DR。',
    },
    native_module: {
      title: '本机组件兼容性异常',
      message: '某个本机组件无法在当前系统环境中正常加载。',
      detail: '这通常与系统运行库、CPU 架构或打包文件不完整有关。请查看下方日志中的组件名称。',
    },
    child_crash: {
      title: '内置服务异常退出',
      message: 'TX-5DR 的内置服务在启动过程中意外退出。',
      detail: '请查看下方日志中的最后几行错误；如果是 Windows 运行库问题，安装或修复 Microsoft Visual C++ Redistributable 可能有帮助。',
    },
    child_start_failed: {
      title: '内置服务无法启动',
      message: 'TX-5DR 无法启动某个必要的本地服务进程。',
      detail: '请确认应用文件完整，并检查安全软件是否阻止了本地进程启动。',
    },
    unknown: {
      title: '启动失败',
      message: 'TX-5DR 启动过程中遇到了未能自动归类的问题。',
      detail: '请查看下方实时日志中的错误信息，然后重启应用重试。',
    },
    devBackendHint: '开发模式下，请确认已通过 yarn dev:electron 启动后端服务。',
    devFrontendHint: '开发模式下，请确认前端开发服务器正在运行。',
    realtimeFallbackHint: '如果日志中提到 node-datachannel，不影响基础使用；实时音频仍可回退到兼容模式。',
    testHint: '这是通过测试开关主动触发的错误，用于检查 loading 页面错误卡片展示效果。',
  },
  httpsSelfSigned: {
    title: '浏览器可能提示证书不安全',
    detail: '当前浏览器入口使用自签名证书。首次访问时，浏览器可能会提示连接不安全；如果这是你自己的设备，请手动放行后继续访问。',
  },
  menu: {
    openMainWindow: '打开主窗口',
    openDevTools: '打开开发者工具',
    logViewer: '日志查看器',
    openInBrowser: '在浏览器中打开',
    about: '关于 TX-5DR',
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
  startupErrors: {
    logHint: 'You can check the live logs below, or click the folder icon in the top-right of the log area to open the log folder.',
    actions: {
      'open-vc-runtime-download': 'Download VC++ Runtime',
    },
    vc_runtime: {
      title: 'VC++ Runtime Required',
      message: 'TX-5DR needs Microsoft Visual C++ Redistributable (x64) to start correctly.',
      detail: 'Click the button below to download and install the runtime, then restart TX-5DR.',
    },
    server_timeout: {
      title: 'Backend Service Did Not Start',
      message: 'TX-5DR opened the window, but the backend service was not ready in time.',
      detail: 'Please restart the app after a moment. If it keeps happening, use the logs below to inspect the error.',
    },
    web_timeout: {
      title: 'Interface Service Did Not Start',
      message: 'The local interface service was not ready in time, so the main UI cannot open yet.',
      detail: 'Please make sure local resources and ports are not blocked by another program, then restart the app.',
    },
    port_conflict: {
      title: 'Startup Port Is In Use',
      message: 'TX-5DR could not find an available local port for its embedded services.',
      detail: 'Please close programs that may be using the required ports, or restart TX-5DR later.',
    },
    native_module: {
      title: 'Native Component Compatibility Issue',
      message: 'A native component could not be loaded in the current system environment.',
      detail: 'This is usually related to system runtimes, CPU architecture, or incomplete app files. Check the logs below for the component name.',
    },
    child_crash: {
      title: 'Embedded Service Exited Unexpectedly',
      message: 'One of TX-5DR’s embedded services quit during startup.',
      detail: 'Check the last few log lines below. On Windows, installing or repairing Microsoft Visual C++ Redistributable may help.',
    },
    child_start_failed: {
      title: 'Embedded Service Could Not Start',
      message: 'TX-5DR could not start a required local service process.',
      detail: 'Please make sure the app files are complete and security software is not blocking local processes.',
    },
    unknown: {
      title: 'Startup Failed',
      message: 'TX-5DR encountered a startup issue that could not be categorized automatically.',
      detail: 'Please inspect the live logs below, then restart the app and try again.',
    },
    devBackendHint: 'In development mode, make sure the backend is started through yarn dev:electron.',
    devFrontendHint: 'In development mode, make sure the frontend development server is running.',
    realtimeFallbackHint: 'If the logs mention node-datachannel, basic usage is still available; realtime audio can fall back to compatibility mode.',
    testHint: 'This error was triggered by the test switch to verify the loading-page error card.',
  },
  httpsSelfSigned: {
    title: 'Your browser may warn about the certificate',
    detail: 'This browser entrypoint currently uses a self-signed certificate. The first visit may show a security warning; if this is your own device, continue manually after confirming it is expected.',
  },
  menu: {
    openMainWindow: 'Open Main Window',
    openDevTools: 'Open DevTools',
    logViewer: 'Log Viewer',
    openInBrowser: 'Open in Browser',
    about: 'About TX-5DR',
    quit: 'Quit',
  },
};

export function getMessages(locale: string): ElectronMessages {
  return locale.startsWith('zh') ? ZH : EN;
}
