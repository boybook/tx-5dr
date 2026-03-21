/* eslint-disable @typescript-eslint/no-explicit-any */
// Server入口 - Fastify插件和错误处理需要使用any

import { createServer } from './server.js';
import { DigitalRadioEngine } from './DigitalRadioEngine.js';
import { initializeConsoleLogger, ConsoleLogger } from './utils/console-logger.js';
import { setGlobalInspector } from './state-machines/inspector.js';

const PORT = Number(process.env.PORT) || 4000;

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
  console.error('[GlobalErrorHandler] Unhandled Promise Rejection:');
  console.error('Reason:', reason);

  const { recoverable, category } = isRecoverableError(reason);

  if (recoverable) {
    console.warn(`[GlobalErrorHandler] ${category} error, system will continue`);
  } else {
    console.error(`[GlobalErrorHandler] ${category} error, not exiting process`);
  }

  // 不退出进程，让系统继续运行
  // process.exit(1); // 注释掉，防止崩溃
});

process.on('uncaughtException', (error: Error) => {
  console.error('[GlobalErrorHandler] Uncaught exception:');
  console.error('Error:', error);
  console.error('Stack:', error.stack);

  const { recoverable, category } = isRecoverableError(error);

  if (recoverable) {
    console.warn(`[GlobalErrorHandler] ${category} error, server will continue`);
  } else {
    console.error(`[GlobalErrorHandler] ${category} critical error, attempting to continue`);
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
            console.error('[XState Inspect] Error:', error.message);
          },
        });
        setGlobalInspector(inspector);
        console.log('[XState Inspect] Visual debugging enabled');
        console.log('[XState Inspect] Visit: https://stately.ai/inspect');
      } catch (err: any) {
        console.warn('[XState Inspect] Initialization failed (ignorable):', err.message);
      }
    }

    // 初始化Console日志系统
    const consoleLogger = await initializeConsoleLogger();
    console.log('Console logger initialized');
    console.log(`Log file: ${consoleLogger.getLogFilePath()}`);

    const server = await createServer();
    await server.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`TX-5DR server running on http://localhost:${PORT}`);

    // 启动时钟系统
    const clockManager = DigitalRadioEngine.getInstance();
    console.log('Starting clock system...');

    await clockManager.start();
    console.log('Server startup complete');

    // 启动日志管理定时任务
    startLogMaintenanceTasks(consoleLogger);
  } catch (err) {
    console.error('Server startup failed:', err);
    process.exit(1);
  }
}

/**
 * 启动日志维护任务
 */
function startLogMaintenanceTasks(logger: ConsoleLogger): void {
  // 每小时检查一次日志轮转（文件大小超过10MB时轮转）
  const rotationInterval = setInterval(async () => {
    try {
      await logger.rotateLogIfNeeded(10 * 1024 * 1024); // 10MB
    } catch (error) {
      console.error('Log rotation check failed:', error);
    }
  }, 60 * 60 * 1000); // 1小时

  // 每天凌晨2点清理旧日志（保留7天）
  const cleanupInterval = setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 2 && now.getMinutes() === 0) {
      try {
        console.log('Cleaning up old log files...');
        await logger.cleanupOldLogs(7); // 保留7天
        console.log('Old log cleanup complete');
      } catch (error) {
        console.error('Log cleanup failed:', error);
      }
    }
  }, 60 * 1000); // 每分钟检查一次

  // 进程退出时清理定时器
  const cleanup = () => {
    clearInterval(rotationInterval);
    clearInterval(cleanupInterval);
    logger.restore();
  };

  const handleSignal = async (signal: NodeJS.Signals) => {
    console.log(`\nReceived ${signal} signal, shutting down server...`);

    try {
      // 停止 DigitalRadioEngine（这会关闭电台连接和音频流）
      const engine = DigitalRadioEngine.getInstance();
      if (engine.getStatus().isRunning) {
        console.log('Stopping digital radio engine...');
        await engine.stop();
        console.log('Digital radio engine stopped');
      }
    } catch (error) {
      console.error('Failed to stop digital radio engine:', error);
    }

    try {
      cleanup();
      console.log('Cleanup complete');
    } catch (error) {
      console.error('Cleanup failed:', error);
    }

    // 确保进程在收到信号后真正退出
    process.exit(0);
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  // 'exit' 事件仅做清理，不再调用 process.exit()
  process.on('exit', () => {
    try {
      cleanup();
    } catch {}
  });
  
  console.log('Log maintenance tasks started');
}

start(); 
