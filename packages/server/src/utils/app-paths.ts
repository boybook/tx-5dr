import { homedir, platform } from 'os';
import { join, resolve } from 'path';
import { promises as fs } from 'fs';

/**
 * 应用程序信息
 */
interface AppInfo {
  name: string;
  version?: string;
  organizationName?: string;
}

/**
 * 跨平台应用程序路径管理器
 */
export class AppPaths {
  private appInfo: AppInfo;
  private _configDir: string | null = null;
  private _dataDir: string | null = null;
  private _logsDir: string | null = null;
  private _cacheDir: string | null = null;

  constructor(appInfo: AppInfo) {
    this.appInfo = appInfo;
  }

  /**
   * 获取应用程序配置目录
   * - Windows: %APPDATA%\{AppName}
   * - macOS: ~/Library/Application Support/{AppName}
   * - Linux: ~/.config/{AppName}
   * - Docker: TX5DR_CONFIG_DIR环境变量
   */
  async getConfigDir(): Promise<string> {
    if (this._configDir) {
      return this._configDir;
    }

    // Docker环境变量优先
    if (process.env.TX5DR_CONFIG_DIR) {
      this._configDir = process.env.TX5DR_CONFIG_DIR;
      await this.ensureDirectoryExists(this._configDir);
      return this._configDir;
    }

    const os = platform();
    let configDir: string;

    switch (os) {
      case 'win32':
        configDir = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), this.appInfo.name);
        break;
      case 'darwin':
        configDir = join(homedir(), 'Library', 'Application Support', this.appInfo.name);
        break;
      default: // Linux and others
        const xdgConfigHome = process.env.XDG_CONFIG_HOME;
        configDir = xdgConfigHome 
          ? join(xdgConfigHome, this.appInfo.name)
          : join(homedir(), '.config', this.appInfo.name);
        break;
    }

    await this.ensureDirectoryExists(configDir);
    this._configDir = configDir;
    return configDir;
  }

  /**
   * 获取应用程序数据目录
   * - Windows: %LOCALAPPDATA%\{AppName}
   * - macOS: ~/Library/Application Support/{AppName}
   * - Linux: ~/.local/share/{AppName}
   * - Docker: TX5DR_DATA_DIR环境变量
   */
  async getDataDir(): Promise<string> {
    if (this._dataDir) {
      return this._dataDir;
    }

    // Docker环境变量优先
    if (process.env.TX5DR_DATA_DIR) {
      this._dataDir = process.env.TX5DR_DATA_DIR;
      await this.ensureDirectoryExists(this._dataDir);
      return this._dataDir;
    }

    const os = platform();
    let dataDir: string;

    switch (os) {
      case 'win32':
        dataDir = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), this.appInfo.name);
        break;
      case 'darwin':
        dataDir = join(homedir(), 'Library', 'Application Support', this.appInfo.name);
        break;
      default: // Linux and others
        const xdgDataHome = process.env.XDG_DATA_HOME;
        dataDir = xdgDataHome 
          ? join(xdgDataHome, this.appInfo.name)
          : join(homedir(), '.local', 'share', this.appInfo.name);
        break;
    }

    await this.ensureDirectoryExists(dataDir);
    this._dataDir = dataDir;
    return dataDir;
  }

  /**
   * 获取应用程序日志目录
   * - Windows: %LOCALAPPDATA%\{AppName}\logs
   * - macOS: ~/Library/Logs/{AppName}
   * - Linux: ~/.local/share/{AppName}/logs
   * - Docker: TX5DR_LOGS_DIR环境变量
   */
  async getLogsDir(): Promise<string> {
    if (this._logsDir) {
      return this._logsDir;
    }

    // Docker环境变量优先
    if (process.env.TX5DR_LOGS_DIR) {
      this._logsDir = process.env.TX5DR_LOGS_DIR;
      await this.ensureDirectoryExists(this._logsDir);
      return this._logsDir;
    }

    const os = platform();
    let logsDir: string;

    switch (os) {
      case 'win32':
        const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
        logsDir = join(localAppData, this.appInfo.name, 'logs');
        break;
      case 'darwin':
        logsDir = join(homedir(), 'Library', 'Logs', this.appInfo.name);
        break;
      default: // Linux and others
        const dataDir = await this.getDataDir();
        logsDir = join(dataDir, 'logs');
        break;
    }

    await this.ensureDirectoryExists(logsDir);
    this._logsDir = logsDir;
    return logsDir;
  }

  /**
   * 获取应用程序缓存目录
   * - Windows: %LOCALAPPDATA%\{AppName}\cache
   * - macOS: ~/Library/Caches/{AppName}
   * - Linux: ~/.cache/{AppName}
   * - Docker: TX5DR_CACHE_DIR环境变量
   */
  async getCacheDir(): Promise<string> {
    if (this._cacheDir) {
      return this._cacheDir;
    }

    // Docker环境变量优先
    if (process.env.TX5DR_CACHE_DIR) {
      this._cacheDir = process.env.TX5DR_CACHE_DIR;
      await this.ensureDirectoryExists(this._cacheDir);
      return this._cacheDir;
    }

    const os = platform();
    let cacheDir: string;

    switch (os) {
      case 'win32':
        const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
        cacheDir = join(localAppData, this.appInfo.name, 'cache');
        break;
      case 'darwin':
        cacheDir = join(homedir(), 'Library', 'Caches', this.appInfo.name);
        break;
      default: // Linux and others
        const xdgCacheHome = process.env.XDG_CACHE_HOME;
        cacheDir = xdgCacheHome 
          ? join(xdgCacheHome, this.appInfo.name)
          : join(homedir(), '.cache', this.appInfo.name);
        break;
    }

    await this.ensureDirectoryExists(cacheDir);
    this._cacheDir = cacheDir;
    return cacheDir;
  }

  /**
   * 获取配置文件路径
   */
  async getConfigFile(fileName: string = 'config.json'): Promise<string> {
    const configDir = await this.getConfigDir();
    return join(configDir, fileName);
  }

  /**
   * 获取数据文件路径
   */
  async getDataFile(fileName: string): Promise<string> {
    const dataDir = await this.getDataDir();
    return join(dataDir, fileName);
  }

  /**
   * 获取日志文件路径
   */
  async getLogFile(fileName: string): Promise<string> {
    const logsDir = await this.getLogsDir();
    return join(logsDir, fileName);
  }

  /**
   * 获取缓存文件路径
   */
  async getCacheFile(fileName: string): Promise<string> {
    const cacheDir = await this.getCacheDir();
    return join(cacheDir, fileName);
  }

  /**
   * 确保目录存在，如果不存在则创建
   */
  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.access(dirPath);
    } catch (error) {
      await fs.mkdir(dirPath, { recursive: true, mode: 0o755 });
    }
  }

  /**
   * 获取所有目录信息（用于调试）
   */
  async getAllPaths(): Promise<{
    configDir: string;
    dataDir: string;
    logsDir: string;
    cacheDir: string;
    platform: string;
  }> {
    return {
      configDir: await this.getConfigDir(),
      dataDir: await this.getDataDir(),
      logsDir: await this.getLogsDir(),
      cacheDir: await this.getCacheDir(),
      platform: platform(),
    };
  }
}

/**
 * TX-5DR 应用程序路径管理器实例
 */
export const tx5drPaths = new AppPaths({
  name: 'TX-5DR',
  version: '1.0.0',
  organizationName: 'TX5DR'
});

/**
 * 便捷函数 - 获取配置文件路径
 */
export async function getConfigFilePath(fileName: string = 'config.json'): Promise<string> {
  return tx5drPaths.getConfigFile(fileName);
}

/**
 * 便捷函数 - 获取数据文件路径  
 */
export async function getDataFilePath(fileName: string): Promise<string> {
  return tx5drPaths.getDataFile(fileName);
}

/**
 * 便捷函数 - 获取日志文件路径
 */
export async function getLogFilePath(fileName: string): Promise<string> {
  return tx5drPaths.getLogFile(fileName);
}

/**
 * 便捷函数 - 获取缓存文件路径
 */
export async function getCacheFilePath(fileName: string): Promise<string> {
  return tx5drPaths.getCacheFile(fileName);
}

/**
 * 便捷函数 - 获取所有路径信息
 */
export async function getAllAppPaths() {
  return tx5drPaths.getAllPaths();
} 