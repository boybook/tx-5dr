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

// WebSocket连接管理
const wsClients = new Set<WebSocket>();

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

  // 设置DigitalRadioEngine事件监听器，转发到WebSocket客户端
  digitalRadioEngine.on('modeChanged', (mode) => {
    broadcastToClients({
      type: 'modeChanged',
      data: mode,
      timestamp: new Date().toISOString()
    });
  });

  digitalRadioEngine.on('clockStarted', () => {
    broadcastToClients({
      type: 'clockStarted',
      data: {},
      timestamp: new Date().toISOString()
    });
  });

  digitalRadioEngine.on('clockStopped', () => {
    broadcastToClients({
      type: 'clockStopped',
      data: {},
      timestamp: new Date().toISOString()
    });
  });

  digitalRadioEngine.on('slotStart', (slotInfo) => {
    broadcastToClients({
      type: 'slotStart',
      data: slotInfo,
      timestamp: new Date().toISOString()
    });
  });

  digitalRadioEngine.on('subWindow', (windowInfo) => {
    broadcastToClients({
      type: 'subWindow',
      data: windowInfo,
      timestamp: new Date().toISOString()
    });
  });

  digitalRadioEngine.on('slotPackUpdated', (slotPack) => {
    broadcastToClients({
      type: 'slotPackUpdated',
      data: slotPack,
      timestamp: new Date().toISOString()
    });
  });

  digitalRadioEngine.on('decodeError', (errorInfo) => {
    broadcastToClients({
      type: 'decodeError',
      data: errorInfo,
      timestamp: new Date().toISOString()
    });
  });

  // 广播消息到所有WebSocket客户端
  function broadcastToClients(message: any) {
    const messageStr = JSON.stringify(message);
    wsClients.forEach((client) => {
      if (client.readyState === client.OPEN) {
        try {
          client.send(messageStr);
        } catch (error) {
          fastify.log.error('发送WebSocket消息失败:', error);
          wsClients.delete(client);
        }
      } else {
        wsClients.delete(client);
      }
    });
  }

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

  // 注册时钟管理API路由
  await fastify.register(clockRoutes, { prefix: '/api/clock' });
  fastify.log.info('时钟管理API路由注册完成');

  // 注册时隙包管理API路由
  await fastify.register(slotpackRoutes, { prefix: '/api/slotpack' });
  fastify.log.info('时隙包管理API路由注册完成');

  // WebSocket endpoint for real-time communication
  fastify.get('/api/ws', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    fastify.log.info('WebSocket客户端已连接');
    
    // 添加到客户端集合
    wsClients.add(socket);
    
    // 发送欢迎消息
    socket.send(JSON.stringify({
      type: 'welcome',
      message: 'Connected to TX-5DR WebSocket server',
      timestamp: new Date().toISOString()
    }));

    // 发送当前系统状态
    const status = digitalRadioEngine.getStatus();
    socket.send(JSON.stringify({
      type: 'systemStatus',
      data: status,
      timestamp: new Date().toISOString()
    }));

    // 处理接收到的消息
    socket.on('message', async (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        fastify.log.info('收到WebSocket消息:', message.toString());
        
        // 处理不同类型的命令
        switch (data.type) {
          case 'startEngine':
            try {
              await digitalRadioEngine.start();
              socket.send(JSON.stringify({
                type: 'commandResult',
                command: 'startEngine',
                success: true,
                timestamp: new Date().toISOString()
              }));
            } catch (error) {
              socket.send(JSON.stringify({
                type: 'commandResult',
                command: 'startEngine',
                success: false,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
              }));
            }
            break;

          case 'stopEngine':
            try {
              await digitalRadioEngine.stop();
              socket.send(JSON.stringify({
                type: 'commandResult',
                command: 'stopEngine',
                success: true,
                timestamp: new Date().toISOString()
              }));
            } catch (error) {
              socket.send(JSON.stringify({
                type: 'commandResult',
                command: 'stopEngine',
                success: false,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
              }));
            }
            break;

          case 'getStatus':
            const currentStatus = digitalRadioEngine.getStatus();
            socket.send(JSON.stringify({
              type: 'systemStatus',
              data: currentStatus,
              timestamp: new Date().toISOString()
            }));
            break;

          case 'ping':
            socket.send(JSON.stringify({
              type: 'pong',
              timestamp: new Date().toISOString()
            }));
            break;

          default:
            // 回显未知消息
            socket.send(JSON.stringify({
              type: 'echo',
              originalMessage: data,
              timestamp: new Date().toISOString()
            }));
        }
      } catch (error) {
        fastify.log.error('解析WebSocket消息错误:', error);
        socket.send(JSON.stringify({
          type: 'error',
          message: 'Invalid JSON format',
          timestamp: new Date().toISOString()
        }));
      }
    });

    // 处理连接关闭
    socket.on('close', () => {
      fastify.log.info('WebSocket客户端已断开连接');
      wsClients.delete(socket);
    });

    // 处理错误
    socket.on('error', (error: Error) => {
      fastify.log.error('WebSocket错误:', error);
      wsClients.delete(socket);
    });
  });

  return fastify;
} 