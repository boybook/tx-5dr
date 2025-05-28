import { createServer } from './server.js';
import { DigitalRadioEngine } from './DigitalRadioEngine.js';

const PORT = Number(process.env.PORT) || 4000;

async function start() {
  try {
    const server = await createServer();
    await server.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 TX-5DR server running on http://localhost:${PORT}`);
    
    // 启动时钟系统进行测试
    const clockManager = DigitalRadioEngine.getInstance();
    console.log('🕐 启动时钟系统进行测试...');
    
    // 切换到多窗口测试模式
    const testMode = clockManager.getAvailableModes().find(m => m.name === 'FT8-MultiWindow');
    if (testMode) {
      console.log('🔄 切换到多窗口测试模式 (FT8-MultiWindow)...');
      await clockManager.setMode(testMode);
    }
    
    await clockManager.start();
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
}

start(); 