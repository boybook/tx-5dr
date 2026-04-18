/* eslint-disable @typescript-eslint/no-explicit-any */
// Server - Fastify服务器配置需要使用any

import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import type { WebSocket } from 'ws';
import type { HelloResponse } from '@tx5dr/contracts';
import type { FastifyRequest, FastifyReply, FastifyError } from 'fastify';
import { ConfigManager } from './config/config-manager.js';
import { DigitalRadioEngine } from './DigitalRadioEngine.js';
import { UserRole } from '@tx5dr/contracts';
import { AuthManager } from './auth/AuthManager.js';
import { authPlugin, withRole } from './auth/authPlugin.js';
import { authRoutes } from './routes/auth.js';
import { audioRoutes } from './routes/audio.js';
import { slotpackRoutes } from './routes/slotpack.js';
import { modeRoutes } from './routes/mode.js';
import { operatorRoutes } from './routes/operators.js';
import { radioRoutes } from './routes/radio.js';
import { powerRoutes } from './routes/power.js';
import { rigctldRoutes } from './routes/rigctld.js';
import { settingsRoutes } from './routes/settings.js';
import { profileRoutes } from './routes/profiles.js';
import { systemRoutes } from './routes/system.js';
import { WSServer } from './websocket/WSServer.js';
import { ProcessMonitor } from './services/ProcessMonitor.js';
import { LogbookWSServer } from './websocket/LogbookWSServer.js';
import { voiceRoutes } from './routes/voice.js';
import { stationRoutes } from './routes/station.js';
import { callsignRoutes } from './routes/callsigns.js';
import { openwebrxRoutes } from './routes/openwebrx.js';
import { realtimeRoutes } from './routes/realtime.js';
import { LiveKitConfig } from './realtime/LiveKitConfig.js';
import { LiveKitBridgeManager } from './realtime/LiveKitBridgeManager.js';
import { RealtimeTransportManager } from './realtime/RealtimeTransportManager.js';
import { getLiveKitCredentialRuntimeStatus } from './realtime/LiveKitCredentialState.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from './utils/errors/RadioError.js';
import { createLogger } from './utils/logger.js';
import { ConsoleLogger } from './utils/console-logger.js';

const bootLogger = createLogger('ServerBoot');

/**
 * 📊 Day14：将 RadioErrorCode 映射到 HTTP 状态码
 */
function getHttpStatusCode(code: RadioErrorCode): number {
  switch (code) {
    // 4xx 客户端错误
    case RadioErrorCode.AUTH_FAILED:
      return 401; // Unauthorized

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
  bootLogger.info('createServer starting');
  const fastify = Fastify({
    trustProxy: true,
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
  fastify.log.info('Config manager initialized');

  // 初始化认证管理器
  const authManager = AuthManager.getInstance();
  await authManager.initialize();
  fastify.log.info('Auth manager initialized');
  const liveKitCredentialStatus = getLiveKitCredentialRuntimeStatus();
  if (!LiveKitConfig.isExplicitlyDisabled() && !liveKitCredentialStatus.initialized) {
    fastify.log.warn({
      credentialFilePath: liveKitCredentialStatus.filePath,
    }, 'LiveKit credentials are missing, realtime transport will fall back to ws-compat mode');
  }
  LiveKitConfig.logEffectiveConfig();

  // 注册认证插件（全局 JWT 验证）
  await fastify.register(authPlugin);
  fastify.log.info('Auth plugin registered');

  // 初始化数字无线电引擎
  bootLogger.info('initializing digital radio engine...');
  ConsoleLogger.getInstance().flushSync();
  const digitalRadioEngine = DigitalRadioEngine.getInstance();
  await digitalRadioEngine.initialize();
  bootLogger.info('digital radio engine initialized');
  ConsoleLogger.getInstance().flushSync();

  fastify.addHook('onClose', async () => {
    await digitalRadioEngine.pluginManager.shutdown();
  });

  // 初始化进程监控（独立于引擎，始终运行）
  const processMonitor = ProcessMonitor.getInstance();
  processMonitor.start();

  // 初始化 LiveKit bridge（统一音频数据面）
  bootLogger.info('starting LiveKit bridge...');
  const liveKitBridgeManager = new LiveKitBridgeManager(digitalRadioEngine);
  await liveKitBridgeManager.start();
  const realtimeTransportManager = RealtimeTransportManager.initialize(digitalRadioEngine, liveKitBridgeManager);
  if (LiveKitConfig.isRuntimeAvailable()) {
    bootLogger.info('LiveKit bridge started, runtime available');
  } else {
    bootLogger.info('LiveKit bridge started in degraded mode, ws-compat active', {
      reason: LiveKitConfig.getRuntimeUnavailableReason(),
    });
  }

  // 初始化WebSocket服务器（集成业务逻辑）
  const wsServer = new WSServer(digitalRadioEngine, processMonitor);
  const logbookWsServer = new LogbookWSServer(digitalRadioEngine);
  fastify.log.info('WebSocket server initialized');

  // Register CORS plugin - 允许所有跨域
  await fastify.register(cors, {
    origin: true, // 允许所有来源
    credentials: true,
  });

  // Register WebSocket plugin
  await fastify.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 1,
    },
  });

  await fastify.register(websocket, {
    options: {
      maxPayload: 1048576, // 1MB 最大消息大小
      clientTracking: true, // 跟踪客户端连接
      // Note: ws.ServerOptions doesn't expose handshakeTimeout (only ClientOptions does).
      // Stalled handshake detection is instead covered by:
      //   1. Nginx proxy_connect_timeout (10s) — catches upstream not accepting
      //   2. WSClient application-level 10s timeout (core/websocket/WSClient.ts) — catches the rest
    }
  });

  // 📊 Day14：Fastify 全局错误处理器
  // 根据 RadioError.code 返回友好错误并添加用户指导信息
  fastify.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    fastify.log.error({ error }, 'API request error');

    // 如果是 RadioError，返回详细的错误信息
    if (error instanceof RadioError) {
      const statusCode = getHttpStatusCode(error.code);

      reply.status(statusCode).send({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          userMessage: error.userMessage,
          userMessageKey: error.userMessageKey,
          userMessageParams: error.userMessageParams,
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
          message: 'Request parameter validation failed',
          userMessage: 'Please check if request parameters are correct',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['Check request parameter format', 'Refer to API documentation'],
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
        message: error.message || 'Internal server error',
        userMessage: statusCode === 500 ? 'Server encountered an error, please try again later' : error.message,
        severity: statusCode === 500 ? RadioErrorSeverity.CRITICAL : RadioErrorSeverity.ERROR,
        suggestions: statusCode === 500
          ? ['Please try again later', 'If the problem persists, contact technical support']
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
    handler: async (_request, _reply) => {
      return { status: 'ok', service: 'TX-5DR Server' };
    },
  });

  // Hello API route
  fastify.get<{ Reply: HelloResponse }>('/api/hello', async (_request, _reply) => {
    return { message: 'Hello World' };
  });

  // ===== 路由注册（带权限保护） =====
  bootLogger.info('registering routes...');
  ConsoleLogger.getInstance().flushSync();

  // Admin 路由：音频、Profile、设置、存储、第三方服务
  await fastify.register(async (scope) => {
    await scope.register(withRole(UserRole.ADMIN));
    await scope.register(audioRoutes, { prefix: '/api/audio' });
    await scope.register(profileRoutes, { prefix: '/api/profiles' });
    await scope.register(settingsRoutes, { prefix: '/api/settings' });
    const { storageRoutes } = await import('./routes/storage.js');
    await scope.register(storageRoutes, { prefix: '/api/storage' });
    const { pskreporterRoutes } = await import('./routes/pskreporter.js');
    await scope.register(pskreporterRoutes, { prefix: '/api' });
    await scope.register(systemRoutes, { prefix: '/api/system' });
    await scope.register(openwebrxRoutes, { prefix: '/api/openwebrx' });
  });
  fastify.log.info('Admin routes registered (audio, profiles, settings, storage, pskreporter, system, openwebrx)');

  // Viewer+ 路由：操作员（内部根据角色过滤）、电台状态、模式、时隙包、语音
  await fastify.register(async (scope) => {
    await scope.register(withRole(UserRole.VIEWER));
    await scope.register(operatorRoutes, { prefix: '/api/operators' });
    await scope.register(radioRoutes, { prefix: '/api/radio' });
    await scope.register(powerRoutes, { prefix: '/api/radio/power' });
    await scope.register(rigctldRoutes, { prefix: '/api/rigctld' });
    await scope.register(modeRoutes, { prefix: '/api/mode' });
    await scope.register(slotpackRoutes, { prefix: '/api/slotpack' });
    await scope.register(voiceRoutes, { prefix: '/api/voice' });
    await scope.register(callsignRoutes, { prefix: '/api/callsigns' });
  });
  fastify.log.info('Viewer+ routes registered (operators, radio, mode, slotpack, voice, callsigns)');

  // Operator+ 路由：日志本（细粒度权限由路由内部 preHandler 控制）
  await fastify.register(async (scope) => {
    await scope.register(withRole(UserRole.OPERATOR));
    const { logbookRoutes } = await import('./routes/logbooks.js');
    await scope.register(logbookRoutes, { prefix: '/api/logbooks' });
  });
  fastify.log.info('Operator+ routes registered (logbooks)');

  const { pluginRoutes } = await import('./routes/plugins.js');
  await fastify.register(pluginRoutes, { prefix: '/api/plugins' });
  fastify.log.info('Plugin routes registered');

  // 公开路由：认证
  await fastify.register(authRoutes, { prefix: '/api/auth' });
  fastify.log.info('Auth routes registered');

  // 实时房间 token
  await fastify.register(realtimeRoutes, { prefix: '/api/realtime' });
  fastify.log.info('Realtime routes registered');

  // 公开路由：电台站信息（GET 无需认证，PUT 由路由内部 preHandler 保护）
  await fastify.register(stationRoutes, { prefix: '/api/station' });
  fastify.log.info('Station routes registered');

  // WebSocket endpoint for real-time communication
  fastify.get('/api/ws', { websocket: true }, (socket: WebSocket, _req: FastifyRequest) => {
    fastify.log.info('WebSocket client connected');
    
    // 添加连接到WebSocket服务器（业务逻辑已集成在WSServer中）
    wsServer.addConnection(socket);
  });

  // Logbook 专用 WebSocket endpoint（仅轻量通知）
  // 注意：浏览器 WebSocket 无法设置 Authorization 头，JWT 通过 ?token= 参数传递
  fastify.get('/api/ws/logbook', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const operatorId = url.searchParams.get('operatorId') || undefined;
      const logBookId = url.searchParams.get('logBookId') || undefined;
      const jwtToken = url.searchParams.get('token');

      // 认证未启用时直接放行（向后兼容）
      if (!authManager.isAuthEnabled()) {
        fastify.log.info(`Logbook WS client connected (no-auth mode): operatorId=${operatorId || ''}, logBookId=${logBookId || ''}`);
        logbookWsServer.addConnection(socket, { operatorId, logBookId });
        return;
      }

      // 认证已启用：必须提供 JWT
      if (!jwtToken) {
        fastify.log.warn('Logbook WS connection missing token, rejecting');
        socket.close(4001, 'Unauthenticated');
        return;
      }

      // 验证 JWT
      let decoded: import('@tx5dr/contracts').JWTPayload;
      try {
        decoded = fastify.jwt.verify<import('@tx5dr/contracts').JWTPayload>(jwtToken);
      } catch {
        fastify.log.warn('Logbook WS JWT verification failed');
        socket.close(4001, 'Token invalid');
        return;
      }

      // 检查 token 是否仍有效（未撤销/未过期）
      if (!authManager.isTokenStillValid(decoded.tokenId)) {
        fastify.log.warn(`Logbook WS token expired: ${decoded.tokenId}`);
        socket.close(4001, 'Token expired');
        return;
      }

      // 获取最新权限
      const current = authManager.getTokenCurrentPermissions(decoded.tokenId);
      if (!current) {
        socket.close(4001, 'Token permission retrieval failed');
        return;
      }

      // 检查最低角色
      if (!AuthManager.hasMinRole(current.role, UserRole.OPERATOR)) {
        fastify.log.warn(`Logbook WS connection insufficient permissions (role=${current.role}), rejecting`);
        socket.close(4003, 'Insufficient permissions, Operator role or above required');
        return;
      }

      // 归属校验：若指定了 logBookId 且非 ADMIN，检查是否有权访问
      if (logBookId && current.role !== UserRole.ADMIN) {
        const wsLogManager = digitalRadioEngine.operatorManager.getLogManager();
        const associated = wsLogManager.getOperatorIdsForLogBook(logBookId);
        const hasAccess = associated.length > 0 &&
          associated.some(id => current.operatorIds.includes(id));
        if (!hasAccess) {
          fastify.log.warn(`Logbook WS connection has no access to log book ${logBookId}, rejecting`);
          socket.close(4003, 'No log book access permission');
          return;
        }
      }

      fastify.log.info(`Logbook WS client connected: operatorId=${operatorId || ''}, logBookId=${logBookId || ''}`);
      logbookWsServer.addConnection(socket, { operatorId, logBookId });
    } catch (e) {
      fastify.log.warn('Logbook WS connection parameter parsing failed, connecting in unfiltered mode');
      logbookWsServer.addConnection(socket);
    }
  });

  // 服务器关闭时清理WebSocket连接
  fastify.addHook('onClose', async () => {
    processMonitor.stop();
    await liveKitBridgeManager.stop();
    wsServer.cleanup();
    logbookWsServer.cleanup();
  });

  fastify.get('/api/realtime/ws-compat', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    realtimeTransportManager.acceptCompatConnection(socket, req.url);
  });

  return fastify;
}
