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
    
    await clockManager.start();
    console.log('✅ 服务器启动完成！');
  } catch (err) {
    console.error('❌ 服务器启动失败:', err);
    process.exit(1);
  }
}

start(); 