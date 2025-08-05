/**
 * 窗口管理工具
 * 处理在Electron和Web环境中打开新窗口的逻辑
 */

interface LogbookWindowOptions {
  operatorId: string;
  logBookId?: string;
}

/**
 * 检查是否在Electron环境中运行
 */
function isElectron(): boolean {
  return typeof window !== 'undefined' && 
         window.navigator && 
         window.navigator.userAgent.toLowerCase().indexOf('electron') > -1;
}

/**
 * 打开通联日志窗口
 */
export function openLogbookWindow(options: LogbookWindowOptions): void {
  const { operatorId, logBookId } = options;
  
  // 构建URL参数
  const params = new URLSearchParams({
    operatorId,
    ...(logBookId && { logBookId }),
  });
  
  if (isElectron()) {
    // Electron环境：通过IPC通信请求打开新窗口
    openElectronLogbookWindow(params.toString());
  } else {
    // Web环境：在新标签页中打开
    openWebLogbookWindow(params.toString());
  }
}

/**
 * 在Electron中打开通联日志窗口
 */
function openElectronLogbookWindow(queryString: string): void {
  try {
    // 检查是否有可用的Electron IPC
    if (typeof window !== 'undefined' && (window as any).electronAPI?.window?.openLogbookWindow) {
      (window as any).electronAPI.window.openLogbookWindow(queryString);
    } else {
      console.warn('Electron IPC不可用，回退到Web模式');
      openWebLogbookWindow(queryString);
    }
  } catch (error) {
    console.error('打开Electron窗口失败:', error);
    // 回退到Web模式
    openWebLogbookWindow(queryString);
  }
}

/**
 * 在Web中打开通联日志窗口
 */
function openWebLogbookWindow(queryString: string): void {
  const baseUrl = window.location.origin;
  const logbookUrl = `${baseUrl}/logbook.html?${queryString}`;
  
  // 在新标签页中打开（不指定窗口特性）
  const newWindow = window.open(logbookUrl, '_blank');
  
  if (newWindow) {
    newWindow.focus();
  } else {
    console.error('无法打开新标签页，可能被浏览器阻止');
    // 提供后备方案：在同一标签页中打开
    window.location.href = logbookUrl;
  }
}

/**
 * 获取当前操作员的通联日志URL
 */
export function getLogbookUrl(operatorId: string, logBookId?: string): string {
  const params = new URLSearchParams({
    operatorId,
    ...(logBookId && { logBookId }),
  });
  
  const baseUrl = window.location.origin;
  return `${baseUrl}/logbook.html?${params.toString()}`;
}