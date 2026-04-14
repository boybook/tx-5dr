/* eslint-disable @typescript-eslint/no-explicit-any */
// Server入口 - Fastify插件和错误处理需要使用any

import { createServer } from './server.js';
import { DigitalRadioEngine } from './DigitalRadioEngine.js';
import { initializeConsoleLogger, ConsoleLogger } from './utils/console-logger.js';
import { setGlobalInspector } from './state-machines/inspector.js';
import { createLogger, setLogLevel, getActiveLogLevel } from './utils/logger.js';
import { ConfigManager } from './config/config-manager.js';
import { markProcessShuttingDown } from './utils/process-shutdown.js';

const logger = createLogger('Server');

const PORT = Number(process.env.PORT) || 4000;
const SERVER_SHUTDOWN_TIMEOUT_MS = 1800;

// ===== 全局错误处理器 =====
// 防止未捕获的 Promise rejection 导致进程崩溃

/**
 * 判断是否是可恢复的错误（不应该导致进程退出）
 */
function isRecoverableError(error: any): { recoverable: boolean; category: string } {
  if (!error || typeof error !== 'object') {
    return { recoverable: false, category: 'unknown' };
  }

  // 网络相关错误（通常可恢复）
  const networkErrorCodes = ['EHOSTDOWN', 'ENETDOWN', 'ENETUNREACH', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'];
  if (error.code && networkErrorCodes.includes(error.code)) {
    return { recoverable: true, category: 'network' };
  }

  // UDP/Socket 操作错误（通常可恢复）
  const recoverableSyscalls = ['send', 'connect', 'recv', 'recvfrom'];
  if (error.syscall && recoverableSyscalls.includes(error.syscall)) {
    return { recoverable: true, category: 'socket' };
  }

  // 用户主动断开连接（可恢复）
  if (error.message && error.message.includes('User disconnect')) {
    return { recoverable: true, category: 'user-disconnect' };
  }

  // 电台设备错误（可恢复）- 通过堆栈追踪识别而非关键词
  if (error.stack) {
    const isRadioError = error.stack.includes('PhysicalRadioManager') ||
                        error.stack.includes('IcomWlanConnection') ||
                        error.stack.includes('radio/');
    if (isRadioError) {
      return { recoverable: true, category: 'radio-device' };
    }
  }

  // 默认认为不可恢复
  return { recoverable: false, category: 'critical' };
}

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  logger.error('unhandled promise rejection', { reason, promise });

  const { recoverable, category } = isRecoverableError(reason);

  if (recoverable) {
    logger.warn(`${category} error, system will continue`);
  } else {
    logger.error(`${category} error, not exiting process`);
  }

  // 不退出进程，让系统继续运行
  // process.exit(1); // 注释掉，防止崩溃
});

process.on('uncaughtException', (error: Error) => {
  logger.error('uncaught exception', error);

  const { recoverable, category } = isRecoverableError(error);

  if (recoverable) {
    logger.warn(`${category} error, server will continue`);
  } else {
    logger.error(`${category} critical error, attempting to continue`);
    // 对于真正严重的错误，可以考虑重启电台引擎而不是退出进程
  }
});

async function start() {
  try {
    // 初始化 XState Inspector（必须在引擎启动前，否则状态机 actor 无法连接）
    if (process.env.NODE_ENV === 'development') {
      try {
        const { createSkyInspector } = await import('@statelyai/inspect');
        const inspector = createSkyInspector({
          onerror: (error) => {
            logger.error('XState inspect error', { message: error.message });
          },
        });
        setGlobalInspector(inspector);
        logger.info('XState visual debugging enabled');
        logger.info('XState inspect URL: https://stately.ai/inspect');
      } catch (err: any) {
        logger.warn('XState inspect initialization failed (ignorable)', { message: err.message });
      }
    }

    // 初始化Console日志系统
    const consoleLogger = await initializeConsoleLogger();
    logger.info('console logger initialized');
    logger.info('log file path', { path: consoleLogger.getLogFilePath() });
    consoleLogger.flushSync();

    const server = await createServer();
    logger.info('createServer completed');
    consoleLogger.flushSync();

    // Apply log level from config.json (overrides LOG_LEVEL env var)
    const configLogLevel = ConfigManager.getInstance().getConfig().logLevel;
    if (configLogLevel) {
      setLogLevel(configLogLevel);
      // Also propagate to core's logger which reads process.env.LOG_LEVEL dynamically
      process.env.LOG_LEVEL = configLogLevel;
      logger.info(`log level set from config: ${configLogLevel}`);
    } else {
      logger.info(`log level: ${getActiveLogLevel()} (from env/default)`);
    }

    await server.listen({ port: PORT, host: '0.0.0.0' });
    logger.info(`TX-5DR server running on http://localhost:${PORT}`);

    // 启动引擎（仅在有激活的 Profile 时）
    const clockManager = DigitalRadioEngine.getInstance();
    const hasActiveProfile = ConfigManager.getInstance().getActiveProfileId() !== null;
    if (hasActiveProfile) {
      logger.info('starting engine');
      await clockManager.start();
    } else {
      logger.info('no active profile, engine startup deferred until profile is configured');
    }
    logger.info('server startup complete');

    // 启动日志管理定时任务
    startLogMaintenanceTasks(consoleLogger);
  } catch (err) {
    logger.error('server startup failed', err);
    process.exit(1);
  }
}

/**
 * 启动日志维护任务
 */
function startLogMaintenanceTasks(consoleLogger: ConsoleLogger): void {
  // 每小时检查一次日志轮转（文件大小超过10MB时轮转）
  const rotationInterval = setInterval(async () => {
    try {
      await consoleLogger.rotateLogIfNeeded(10 * 1024 * 1024); // 10MB
    } catch (error) {
      logger.error('log rotation check failed', error);
    }
  }, 60 * 60 * 1000); // 1小时

  // 每天凌晨2点清理旧日志（保留7天）
  const cleanupInterval = setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 2 && now.getMinutes() === 0) {
      try {
        logger.info('cleaning up old log files');
        await consoleLogger.cleanupOldLogs(7); // 保留7天
        logger.info('old log cleanup complete');
      } catch (error) {
        logger.error('log cleanup failed', error);
      }
    }
  }, 60 * 1000); // 每分钟检查一次

  // 进程退出时清理定时器
  const cleanup = () => {
    clearInterval(rotationInterval);
    clearInterval(cleanupInterval);
    consoleLogger.restore();
  };

  let shutdownPromise: Promise<void> | null = null;

  const handleSignal = async (signal: NodeJS.Signals) => {
    if (shutdownPromise) {
      logger.info(`received ${signal} during shutdown, reusing in-flight shutdown`);
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      const shutdownStartedAt = Date.now();
      const engineStopStartedAt = Date.now();
      let engineStopMs = 0;
      let fastShutdownFallback = false;

      logger.info(`received ${signal} signal, shutting down server`);
      markProcessShuttingDown();

      try {
        const engine = DigitalRadioEngine.getInstance();
        if (engine.getStatus().isRunning) {
          logger.info('stopping digital radio engine');
          await Promise.race([
            engine.stop(),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('server shutdown timeout')), SERVER_SHUTDOWN_TIMEOUT_MS);
            }),
          ]);
          engineStopMs = Date.now() - engineStopStartedAt;
          logger.info('digital radio engine stopped');
        }
      } catch (error) {
        engineStopMs = Date.now() - engineStopStartedAt;
        fastShutdownFallback = true;
        logger.warn('digital radio engine stop exceeded shutdown budget, continuing to exit', {
          timeoutMs: SERVER_SHUTDOWN_TIMEOUT_MS,
          engineStopMs,
          error,
        });
      }

      try {
        cleanup();
        logger.info('cleanup complete');
      } catch (error) {
        logger.error('cleanup failed', error);
      }

      logger.info('server shutdown complete', {
        signal,
        engineStopMs,
        fastShutdownFallback,
        totalMs: Date.now() - shutdownStartedAt,
      });
      process.exit(0);
    })();

    return shutdownPromise;
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  // 'exit' 事件仅做清理，不再调用 process.exit()
  process.on('exit', () => {
    try {
      cleanup();
    } catch {}
  });

  logger.info('log maintenance tasks started');
}

start(); 
