import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { HelloResponse } from '@tx5dr/contracts';
import type { FastifyRequest } from 'fastify';
import { ConfigManager } from './config/config-manager.js';
import { DigitalRadioEngine } from './DigitalRadioEngine.js';
import { audioRoutes } from './routes/audio.js';
import { slotpackRoutes } from './routes/slotpack.js';
import { modeRoutes } from './routes/mode.js';
import { operatorRoutes } from './routes/operators.js';
import { WSServer } from './websocket/WSServer.js';

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

  // 初始化WebSocket服务器（集成业务逻辑）
  const wsServer = new WSServer(digitalRadioEngine);
  fastify.log.info('WebSocket服务器初始化完成');

  // Register CORS plugin
  await fastify.register(cors, {
    origin: (origin, callback) => {
      // 允许的源列表
      const allowedOrigins = [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        // Docker容器端口
        'http://localhost:8080',
        'http://127.0.0.1:8080',
      ];
      
      // 没有origin（同域请求）或来自file://（Electron）的请求
      if (!origin || origin.startsWith('file://')) {
        callback(null, true);
        return;
      }
      
      // 开发环境：允许所有localhost和127.0.0.1的端口
      if (process.env.NODE_ENV === 'development') {
        if (origin.startsWith('http://localhost:') || 
            origin.startsWith('http://127.0.0.1:') ||
            origin.startsWith('https://localhost:') ||
            origin.startsWith('https://127.0.0.1:') ||
            origin.startsWith('http://ylw.boybook.top:')) {
          callback(null, true);
          return;
        }
      }
      
      // 检查是否在允许列表中
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      
      // Docker环境特殊处理：允许内部容器访问
      if (process.env.NODE_ENV === 'production' && origin && 
          (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) {
        callback(null, true);
        return;
      }
      
      fastify.log.warn(`CORS: 拒绝来自 ${origin} 的请求`);
      callback(new Error('Not allowed by CORS'), false);
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

  // 注册时隙包管理API路由
  await fastify.register(slotpackRoutes, { prefix: '/api/slotpack' });
  fastify.log.info('时隙包管理API路由注册完成');

  // 注册模式管理API路由
  await fastify.register(modeRoutes, { prefix: '/api/mode' });
  fastify.log.info('模式管理API路由注册完成');

  // 注册操作员管理API路由
  await fastify.register(operatorRoutes, { prefix: '/api/operators' });
  fastify.log.info('操作员管理API路由注册完成');

  // 注册日志本管理API路由
  const { logbookRoutes } = await import('./routes/logbooks.js');
  await fastify.register(logbookRoutes, { prefix: '/api/logbooks' });
  fastify.log.info('日志本管理API路由注册完成');

  // 注册存储管理API路由
  const { storageRoutes } = await import('./routes/storage.js');
  await fastify.register(storageRoutes, { prefix: '/api/storage' });
  fastify.log.info('存储管理API路由注册完成');

  // WebSocket endpoint for real-time communication
  fastify.get('/api/ws', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    fastify.log.info('WebSocket客户端已连接');
    
    // 添加连接到WebSocket服务器（业务逻辑已集成在WSServer中）
    wsServer.addConnection(socket);
  });

  // 服务器关闭时清理WebSocket连接
  fastify.addHook('onClose', async () => {
    wsServer.cleanup();
  });

  return fastify;
} 