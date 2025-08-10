import { createServer } from './server.js';
import { DigitalRadioEngine } from './DigitalRadioEngine.js';
import { initializeConsoleLogger, ConsoleLogger } from './utils/console-logger.js';

const PORT = Number(process.env.PORT) || 4000;

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

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);
  
  console.log('🔧 日志维护任务已启动');
}

start(); 