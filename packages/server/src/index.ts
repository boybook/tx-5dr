import { createServer } from './server.js';
import { DigitalRadioEngine } from './DigitalRadioEngine.js';
import { initializeConsoleLogger, ConsoleLogger } from './utils/console-logger.js';

const PORT = Number(process.env.PORT) || 4000;

// ===== XState 可视化调试（仅开发环境） =====
// XState v5 使用 @statelyai/inspect 和 inspect API
if (process.env.NODE_ENV === 'development') {
  import('@statelyai/inspect')
    .then(({ createBrowserInspector }) => {
      const inspector = createBrowserInspector();
      console.log('📊 [XState Inspect] 可视化调试已启用 (XState v5)');
      console.log('📊 [XState Inspect] 访问: https://stately.ai/inspect');
      console.log('📊 [XState Inspect] 提示: 在浏览器中打开上述链接查看状态机可视化');
    })
    .catch((err) => {
      console.warn('⚠️  [XState Inspect] 初始化失败（可忽略）:', err.message);
    });
}

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
  console.error('🚨 [全局错误处理器] 未捕获的 Promise Rejection:');
  console.error('原因:', reason);

  const { recoverable, category } = isRecoverableError(reason);

  if (recoverable) {
    console.warn(`⚠️ [全局错误处理器] ${category} 类错误，系统将继续运行`);
  } else {
    console.error(`⚠️ [全局错误处理器] ${category} 类错误，但不退出进程`);
  }

  // 不退出进程，让系统继续运行
  // process.exit(1); // 注释掉，防止崩溃
});

process.on('uncaughtException', (error: Error) => {
  console.error('🚨 [全局错误处理器] 未捕获的异常:');
  console.error('错误:', error);
  console.error('堆栈:', error.stack);

  const { recoverable, category } = isRecoverableError(error);

  if (recoverable) {
    console.warn(`⚠️ [全局错误处理器] ${category} 类错误，服务器将继续运行`);
  } else {
    console.error(`⚠️ [全局错误处理器] ${category} 类严重错误，但将尝试继续运行`);
    // 对于真正严重的错误，可以考虑重启电台引擎而不是退出进程
  }
});

async function start() {
  try {
    // 首先初始化Console日志系统
    const consoleLogger = await initializeConsoleLogger();
    console.log('🔧 Console日志系统已初始化');
    console.log(`📋 日志文件位置: ${consoleLogger.getLogFilePath()}`);
    
    const server = await createServer();
    await server.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 TX-5DR server running on http://localhost:${PORT}`);
    
    // 启动时钟系统进行测试
    const clockManager = DigitalRadioEngine.getInstance();
    console.log('🕐 启动时钟系统进行测试...');
    
    await clockManager.start();
    console.log('✅ 服务器启动完成！');
    
    // 启动日志管理定时任务
    startLogMaintenanceTasks(consoleLogger);
  } catch (err) {
    console.error('❌ 服务器启动失败:', err);
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
      console.error('日志轮转检查失败:', error);
    }
  }, 60 * 60 * 1000); // 1小时

  // 每天凌晨2点清理旧日志（保留7天）
  const cleanupInterval = setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 2 && now.getMinutes() === 0) {
      try {
        console.log('🧹 开始清理旧日志文件...');
        await logger.cleanupOldLogs(7); // 保留7天
        console.log('✅ 旧日志清理完成');
      } catch (error) {
        console.error('日志清理失败:', error);
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
    console.log(`\n🛑 收到 ${signal} 信号，正在关闭服务器...`);

    try {
      // 停止 DigitalRadioEngine（这会关闭电台连接和音频流）
      const engine = DigitalRadioEngine.getInstance();
      if (engine.getStatus().isRunning) {
        console.log('🛑 正在停止数字电台引擎...');
        await engine.stop();
        console.log('✅ 数字电台引擎已停止');
      }
    } catch (error) {
      console.error('❌ 停止数字电台引擎失败:', error);
    }

    try {
      cleanup();
      console.log('✅ 清理完成');
    } catch (error) {
      console.error('❌ 清理失败:', error);
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
  
  console.log('🔧 日志维护任务已启动');
}

start(); 
