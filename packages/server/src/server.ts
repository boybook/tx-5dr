import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { HelloResponse } from '@tx5dr/contracts';
import type { FastifyRequest, FastifyReply, FastifyError } from 'fastify';
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
import { LogbookWSServer } from './websocket/LogbookWSServer.js';
import { AudioMonitorWSServer } from './websocket/AudioMonitorWSServer.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from './utils/errors/RadioError.js';

/**
 * 📊 Day14：将 RadioErrorCode 映射到 HTTP 状态码
 */
function getHttpStatusCode(code: RadioErrorCode): number {
  switch (code) {
    // 4xx 客户端错误
    case RadioErrorCode.INVALID_CONFIG:
    case RadioErrorCode.MISSING_CONFIG:
    case RadioErrorCode.INVALID_OPERATION:
    case RadioErrorCode.INVALID_STATE:
      return 400; // Bad Request

    case RadioErrorCode.UNSUPPORTED_MODE:
      return 400; // Bad Request

    case RadioErrorCode.NOT_INITIALIZED:
    case RadioErrorCode.NOT_RUNNING:
      return 409; // Conflict

    case RadioErrorCode.ALREADY_RUNNING:
      return 409; // Conflict

    case RadioErrorCode.DEVICE_NOT_FOUND:
    case RadioErrorCode.RESOURCE_UNAVAILABLE:
      return 404; // Not Found

    case RadioErrorCode.DEVICE_BUSY:
      return 503; // Service Unavailable

    case RadioErrorCode.OPERATION_CANCELLED:
      return 499; // Client Closed Request

    // 5xx 服务器错误
    case RadioErrorCode.CONNECTION_FAILED:
    case RadioErrorCode.CONNECTION_TIMEOUT:
    case RadioErrorCode.CONNECTION_LOST:
    case RadioErrorCode.RECONNECT_FAILED:
    case RadioErrorCode.RECONNECT_MAX_ATTEMPTS:
      return 503; // Service Unavailable

    case RadioErrorCode.DEVICE_ERROR:
    case RadioErrorCode.AUDIO_DEVICE_ERROR:
    case RadioErrorCode.PTT_ACTIVATION_FAILED:
    case RadioErrorCode.OPERATION_TIMEOUT:
      return 500; // Internal Server Error

    case RadioErrorCode.RESOURCE_CLEANUP_FAILED:
      return 500; // Internal Server Error

    case RadioErrorCode.NETWORK_ERROR:
    case RadioErrorCode.UDP_ERROR:
    case RadioErrorCode.WEBSOCKET_ERROR:
      return 500; // Internal Server Error

    case RadioErrorCode.UNKNOWN_ERROR:
    default:
      return 500; // Internal Server Error
  }
}

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

  // 初始化音频监听WebSocket服务器
  const audioMonitorWSServer = new AudioMonitorWSServer();

  // 初始化WebSocket服务器（集成业务逻辑）
  const wsServer = new WSServer(digitalRadioEngine, audioMonitorWSServer);
  const logbookWsServer = new LogbookWSServer(digitalRadioEngine);
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

  // 📊 Day14：Fastify 全局错误处理器
  // 根据 RadioError.code 返回友好错误并添加用户指导信息
  fastify.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    fastify.log.error('API请求错误:', error);

    // 如果是 RadioError，返回详细的错误信息
    if (error instanceof RadioError) {
      const statusCode = getHttpStatusCode(error.code);

      reply.status(statusCode).send({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          userMessage: error.userMessage,
          severity: error.severity,
          suggestions: error.suggestions,
          timestamp: error.timestamp,
          context: error.context,
        },
      });
      return;
    }

    // 如果是 Fastify 验证错误
    if (error.validation) {
      reply.status(400).send({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '请求参数验证失败',
          userMessage: '请检查请求参数是否正确',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['检查请求参数格式', '参考API文档'],
          details: error.validation,
        },
      });
      return;
    }

    // 其他错误：转换为通用错误响应
    const statusCode = error.statusCode || 500;
    reply.status(statusCode).send({
      success: false,
      error: {
        code: RadioErrorCode.UNKNOWN_ERROR,
        message: error.message || '服务器内部错误',
        userMessage: statusCode === 500 ? '服务器遇到错误，请稍后重试' : error.message,
        severity: statusCode === 500 ? RadioErrorSeverity.CRITICAL : RadioErrorSeverity.ERROR,
        suggestions: statusCode === 500
          ? ['请稍后重试', '如果问题持续，请联系技术支持']
          : [],
      },
    });
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

  // Logbook 专用 WebSocket endpoint（仅轻量通知）
  fastify.get('/api/ws/logbook', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const operatorId = url.searchParams.get('operatorId') || undefined;
      const logBookId = url.searchParams.get('logBookId') || undefined;
      fastify.log.info(`Logbook WS 客户端连接: operatorId=${operatorId || ''}, logBookId=${logBookId || ''}`);
      logbookWsServer.addConnection(socket, { operatorId, logBookId });
    } catch (e) {
      fastify.log.warn('Logbook WS 连接参数解析失败, 以无过滤模式连接');
      logbookWsServer.addConnection(socket);
    }
  });

  // 音频监听专用 WebSocket endpoint（仅传输二进制音频数据）
  fastify.get('/api/ws/audio-monitor', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const clientId = url.searchParams.get('clientId');

      if (!clientId) {
        fastify.log.warn('音频监听WS连接缺少clientId参数，拒绝连接');
        socket.close();
        return;
      }

      fastify.log.info(`🎧 音频监听WS客户端连接: clientId=${clientId}`);
      audioMonitorWSServer.handleConnection(socket, clientId);
    } catch (e) {
      fastify.log.error('音频监听WS连接参数解析失败:', e);
      socket.close();
    }
  });

  // 服务器关闭时清理WebSocket连接
  fastify.addHook('onClose', async () => {
    wsServer.cleanup();
    logbookWsServer.cleanup();
    audioMonitorWSServer.closeAll();
  });

  return fastify;
} 
