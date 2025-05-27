import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { HelloResponse } from '@tx5dr/contracts';
import type { FastifyRequest } from 'fastify';
import { ConfigManager } from './config/config-manager.js';
import { audioRoutes } from './routes/audio.js';
import { configRoutes } from './routes/config.js';

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

  // Register CORS plugin
  await fastify.register(cors, {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
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

  // WebSocket endpoint for real-time communication
  fastify.get('/api/ws', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    fastify.log.info('WebSocket client connected');
    
    // 发送欢迎消息
    socket.send(JSON.stringify({
      type: 'welcome',
      message: 'Connected to TX-5DR WebSocket server',
      timestamp: new Date().toISOString()
    }));

    // 处理接收到的消息
    socket.on('message', (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        fastify.log.info('Received WebSocket message:', data);
        
        // 回显消息
        socket.send(JSON.stringify({
          type: 'echo',
          originalMessage: data,
          timestamp: new Date().toISOString()
        }));
      } catch (error) {
        fastify.log.error('Error parsing WebSocket message:', error);
        socket.send(JSON.stringify({
          type: 'error',
          message: 'Invalid JSON format',
          timestamp: new Date().toISOString()
        }));
      }
    });

    // 处理连接关闭
    socket.on('close', () => {
      fastify.log.info('WebSocket client disconnected');
    });

    // 处理错误
    socket.on('error', (error: Error) => {
      fastify.log.error('WebSocket error:', error);
    });
  });

  return fastify;
} 