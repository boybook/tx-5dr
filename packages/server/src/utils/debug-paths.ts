import { getAllAppPaths } from './app-paths.js';
import { createLogger } from './logger.js';

const logger = createLogger('DebugPaths');

/**
 * 打印所有应用程序路径信息（用于调试）
 */
export async function printAppPaths(): Promise<void> {
  logger.debug('===== TX-5DR App Paths =====');

  try {
    const paths = await getAllAppPaths();

    logger.debug(`OS: ${paths.platform}`);
    logger.debug(`Config dir: ${paths.configDir}`);
    logger.debug(`Data dir: ${paths.dataDir}`);
    logger.debug(`Logs dir: ${paths.logsDir}`);
    logger.debug(`Cache dir: ${paths.cacheDir}`);

    switch (paths.platform) {
      case 'win32':
        logger.debug('Windows path standard: config=%APPDATA%\\TX-5DR, data=%LOCALAPPDATA%\\TX-5DR');
        break;
      case 'darwin':
        logger.debug('macOS path standard: ~/Library/Application Support/TX-5DR');
        break;
      default:
        logger.debug('Linux path standard: ~/.config/TX-5DR');
        break;
    }

    logger.debug('All directories created and ready');

  } catch (error) {
    logger.error('Failed to get path info:', error);
  }
} 