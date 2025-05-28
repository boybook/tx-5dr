import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { HelloResponse } from '@tx5dr/contracts';
import type { FastifyRequest } from 'fastify';
import { ConfigManager } from './config/config-manager.js';
import { DigitalRadioEngine } from './DigitalRadioEngine.js';
import { audioRoutes } from './routes/audio.js';
import { configRoutes } from './routes/config.js';
import { clockRoutes } from './routes/clock.js';
import { slotpackRoutes } from './routes/slotpack.js';
import { WSServer } from '@tx5dr/core';

export async function createServer() {
  const fastify = Fastify({
    logger: {
      level: 'info',
      // 减少健康检查请求的日志噪音
      serializers: {
        req(request) {
          // 不记录健康检查请求的详细信息
          if (request.url === '/' && request.method === 'HEAD') {
            return { method: request.method, url: request.url };
          }
          return {
            method: request.method,
            url: request.url,
            hostname: request.hostname,
            remoteAddress: request.ip,
          };
        },
      },
    },
  });

  // 初始化配置管理器
  const configManager = ConfigManager.getInstance();
  await configManager.initialize();
  fastify.log.info('配置管理器初始化完成');

  // 初始化数字无线电引擎
  const digitalRadioEngine = DigitalRadioEngine.getInstance();
  await digitalRadioEngine.initialize();
  fastify.log.info('数字无线电引擎初始化完成');

  // 初始化WebSocket服务器
  const wsServer = new WSServer();
  fastify.log.info('WebSocket服务器初始化完成');

  // 设置DigitalRadioEngine事件监听器，转发到WebSocket客户端
  digitalRadioEngine.on('modeChanged', (mode) => {
    console.log('🔄 服务器收到modeChanged事件，广播给客户端');
    wsServer.broadcastModeChanged(mode);
  });

  digitalRadioEngine.on('clockStarted', () => {
    console.log('🚀 服务器收到clockStarted事件，广播给客户端');
    wsServer.broadcastClockStarted();
  });

  digitalRadioEngine.on('clockStopped', () => {
    console.log('⏹️ 服务器收到clockStopped事件，广播给客户端');
    wsServer.broadcastClockStopped();
  });

  digitalRadioEngine.on('slotStart', (slotInfo) => {
    wsServer.broadcastSlotStart(slotInfo);
  });

  digitalRadioEngine.on('subWindow', (windowInfo) => {
    wsServer.broadcastSubWindow(windowInfo);
  });

  digitalRadioEngine.on('slotPackUpdated', (slotPack) => {
    wsServer.broadcastSlotPackUpdated(slotPack);
  });

  digitalRadioEngine.on('decodeError', (errorInfo) => {
    wsServer.broadcastDecodeError(errorInfo);
  });

  // 设置WebSocket服务器事件监听器，处理客户端命令
  wsServer.onWSEvent('rawMessage', async (message: any) => {
    // 处理不同类型的命令
    switch (message.type) {
      case 'startEngine':
        console.log('📥 服务器收到startEngine命令');
        try {
          const currentStatus = digitalRadioEngine.getStatus();
          if (currentStatus.isRunning) {
            console.log('⚠️ 时钟已经在运行中，发送当前状态同步');
            // 时钟已经在运行，直接发送状态同步事件
            wsServer.broadcastClockStarted();
          } else {
            await digitalRadioEngine.start();
            console.log('✅ digitalRadioEngine.start() 执行成功');
          }
        } catch (error) {
          console.error('❌ digitalRadioEngine.start() 执行失败:', error);
        }
        break;

      case 'stopEngine':
        console.log('📥 服务器收到stopEngine命令');
        try {
          const currentStatus = digitalRadioEngine.getStatus();
          if (!currentStatus.isRunning) {
            console.log('⚠️ 时钟已经停止，发送当前状态同步');
            // 时钟已经停止，直接发送状态同步事件
            wsServer.broadcastClockStopped();
            wsServer.broadcast('commandResult', {
              command: 'stopEngine',
              success: true,
              message: 'Already stopped'
            });
          } else {
            await digitalRadioEngine.stop();
            console.log('✅ digitalRadioEngine.stop() 执行成功');
            wsServer.broadcast('commandResult', {
              command: 'stopEngine',
              success: true
            });
          }
        } catch (error) {
          console.error('❌ digitalRadioEngine.stop() 执行失败:', error);
          wsServer.broadcast('commandResult', {
            command: 'stopEngine',
            success: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        break;

      case 'getStatus':
        const currentStatus = digitalRadioEngine.getStatus();
        wsServer.broadcastSystemStatus(currentStatus);
        break;

      case 'setMode':
        try {
          await digitalRadioEngine.setMode(message.data.mode);
          wsServer.broadcast('commandResult', {
            command: 'setMode',
            success: true
          });
        } catch (error) {
          wsServer.broadcast('commandResult', {
            command: 'setMode',
            success: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        break;

      case 'ping':
        // ping消息由WSServer自动处理，发送pong响应
        break;

      default:
        fastify.log.warn('未知的WebSocket消息类型:', message.type);
    }
  });

  // Register CORS plugin
  await fastify.register(cors, {
    origin: (origin, callback) => {
      // 允许的源列表
      const allowedOrigins = [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
      ];
      
      // 开发环境：允许所有localhost和127.0.0.1的端口
      if (process.env.NODE_ENV === 'development' || !origin) {
        if (!origin || 
            origin.startsWith('http://localhost:') || 
            origin.startsWith('http://127.0.0.1:') ||
            origin.startsWith('https://localhost:') ||
            origin.startsWith('https://127.0.0.1:')) {
          callback(null, true);
          return;
        }
      }
      
      // 生产环境：检查是否在允许列表中，或者是同域请求
      if (allowedOrigins.includes(origin) || !origin) {
        callback(null, true);
      } else {
        fastify.log.warn(`CORS: 拒绝来自 ${origin} 的请求`);
        callback(new Error('Not allowed by CORS'), false);
      }
    },
    credentials: true,
  });

  // Register WebSocket plugin
  await fastify.register(websocket, {
    options: {
      maxPayload: 1048576, // 1MB 最大消息大小
      clientTracking: true, // 跟踪客户端连接
    }
  });

  // Try to load native addon (placeholder)
  try {
    // This is a placeholder for a native addon that doesn't exist yet
    // await import('@tx5dr/native');
    fastify.log.info('Native addon placeholder - would load here');
  } catch (error) {
    fastify.log.info('Native addon not available, continuing without it');
  }

  // Health check routes (支持 GET 和 HEAD)
  fastify.route({
    method: ['GET', 'HEAD'],
    url: '/',
    handler: async (request, reply) => {
      return { status: 'ok', service: 'TX-5DR Server' };
    },
  });

  // Hello API route
  fastify.get<{ Reply: HelloResponse }>('/api/hello', async (request, reply) => {
    return { message: 'Hello World' };
  });

  // 注册音频设备API路由
  await fastify.register(audioRoutes, { prefix: '/api/audio' });
  fastify.log.info('音频设备API路由注册完成');

  // 注册配置管理API路由
  await fastify.register(configRoutes, { prefix: '/api/config' });
  fastify.log.info('配置管理API路由注册完成');

  // 注册时钟管理API路由
  await fastify.register(clockRoutes, { prefix: '/api/clock' });
  fastify.log.info('时钟管理API路由注册完成');

  // 注册时隙包管理API路由
  await fastify.register(slotpackRoutes, { prefix: '/api/slotpack' });
  fastify.log.info('时隙包管理API路由注册完成');

  // WebSocket endpoint for real-time communication
  fastify.get('/api/ws', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    fastify.log.info('WebSocket客户端已连接');
    
    // 添加连接到WebSocket服务器
    const connection = wsServer.addConnection(socket);
    
    // 发送当前系统状态
    const status = digitalRadioEngine.getStatus();
    connection.send('systemStatus', status);

    // 连接断开时的清理工作由WSServer自动处理
  });

  // 服务器关闭时清理WebSocket连接
  fastify.addHook('onClose', async () => {
    wsServer.cleanup();
  });

  return fastify;
} 