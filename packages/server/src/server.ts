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
import { radioRoutes } from './routes/radio.js';
import { waveLogRoutes } from './routes/wavelog.js';
import { settingsRoutes } from './routes/settings.js';
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

  // 初始化WaveLog服务
  const { WaveLogServiceManager } = await import('./services/WaveLogService.js');
  const waveLogManager = WaveLogServiceManager.getInstance();
  const waveLogConfig = configManager.getWaveLogConfig();
  if (waveLogConfig.enabled) {
    waveLogManager.initializeService(waveLogConfig);
    fastify.log.info('WaveLog服务初始化完成');
    
    // WaveLog同步服务已准备就绪（仅支持手动触发）
    const { WaveLogSyncScheduler } = await import('./services/WaveLogSyncScheduler.js');
    const syncScheduler = WaveLogSyncScheduler.getInstance();
    fastify.log.info('WaveLog同步服务已准备就绪');
  } else {
    fastify.log.info('WaveLog服务已禁用，跳过初始化');
  }

  // 初始化WebSocket服务器（集成业务逻辑）
  const wsServer = new WSServer(digitalRadioEngine);
  fastify.log.info('WebSocket服务器初始化完成');

  // Register CORS plugin - 允许所有跨域
  await fastify.register(cors, {
    origin: true, // 允许所有来源
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

  await fastify.register(radioRoutes, { prefix: '/api/radio' });
  fastify.log.info('电台控制API路由注册完成');

  // 注册WaveLog同步API路由
  await fastify.register(waveLogRoutes, { prefix: '/api/wavelog' });
  fastify.log.info('WaveLog同步API路由注册完成');

  // 注册日志本管理API路由
  const { logbookRoutes } = await import('./routes/logbooks.js');
  await fastify.register(logbookRoutes, { prefix: '/api/logbooks' });
  fastify.log.info('日志本管理API路由注册完成');

  // 注册存储管理API路由
  const { storageRoutes } = await import('./routes/storage.js');
  await fastify.register(storageRoutes, { prefix: '/api/storage' });
  fastify.log.info('存储管理API路由注册完成');

  // 注册设置管理API路由
  await fastify.register(settingsRoutes, { prefix: '/api/settings' });
  fastify.log.info('设置管理API路由注册完成');

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