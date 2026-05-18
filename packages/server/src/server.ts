/* eslint-disable @typescript-eslint/no-explicit-any */
// Server - Fastify服务器配置需要使用any

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { BootstrapPhaseId, HelloResponse } from '@tx5dr/contracts';
import type { FastifyRequest, FastifyReply, FastifyError } from 'fastify';
import { ConfigManager } from './config/config-manager.js';
import { AudioDeviceManager } from './audio/audio-device-manager.js';
import { DigitalRadioEngine } from './DigitalRadioEngine.js';
import { UserRole } from '@tx5dr/contracts';
import { AuthManager } from './auth/AuthManager.js';
import { DeviceServiceAuthManager } from './auth/DeviceServiceAuthManager.js';
import { authPlugin, requireRole } from './auth/authPlugin.js';
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
import { DeviceUiWSServer } from './device-ui/DeviceUiWSServer.js';
import { deviceUiRoutes } from './device-ui/routes.js';
import { voiceRoutes } from './routes/voice.js';
import { cwRoutes } from './routes/cw.js';
import { stationRoutes } from './routes/station.js';
import { callsignRoutes } from './routes/callsigns.js';
import { openwebrxRoutes } from './routes/openwebrx.js';
import { realtimeRoutes } from './routes/realtime.js';
import { RealtimeTransportManager } from './realtime/RealtimeTransportManager.js';
import { RealtimeRxAudioRouter } from './realtime/RealtimeRxAudioRouter.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from './utils/errors/RadioError.js';
import { createLogger } from './utils/logger.js';
import { ConsoleLogger } from './utils/console-logger.js';
import { PersistenceCoordinator } from './utils/persistence/index.js';
import { areNewMutationsBlocked, blockNewMutations, markProcessShuttingDown } from './utils/process-shutdown.js';
import { bootstrapCoordinator } from './services/BootstrapCoordinator.js';
import { getNetworkAccessInfo } from './utils/network-access.js';

const bootLogger = createLogger('ServerBoot');
const logger = createLogger('Server');
const INTERNAL_PREPARE_SHUTDOWN_DEADLINE_MS = 32_000;
const INTERNAL_ENGINE_STOP_TIMEOUT_MS = 8_000;
const RETRYABLE_BOOTSTRAP_PHASES = new Set<BootstrapPhaseId>([
  'audio-device-discovery',
  'logbook-prewarm',
  'plugin-bootstrap',
  'ntp-initial-check',
  'active-profile-autostart',
]);

function safeTokenEquals(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
}

function remainingDeadlineMs(startedAt: number, deadlineMs: number): number {
  return Math.max(1, deadlineMs - (Date.now() - startedAt));
}

function retryBootstrapPhase(phaseId: BootstrapPhaseId, digitalRadioEngine: DigitalRadioEngine): void {
  const run = async () => {
    switch (phaseId) {
      case 'audio-device-discovery':
        await bootstrapCoordinator.runPhase(
          phaseId,
          () => AudioDeviceManager.getInstance().initializeDeviceRegistry(),
          {
            timeoutMs: 15_000,
            pendingMessage: 'Rediscovering audio devices',
            successMessage: 'Audio device discovery completed',
            failureMessage: 'Audio device discovery failed; retry later',
          },
        );
        return;
      case 'logbook-prewarm':
        digitalRadioEngine.operatorManager.getLogManager().retryBootstrapPrewarm?.();
        return;
      case 'plugin-bootstrap':
        await bootstrapCoordinator.runPhase(
          phaseId,
          () => digitalRadioEngine.pluginManager.start(),
          {
            timeoutMs: 15_000,
            pendingMessage: 'Reloading plugins',
            successMessage: 'Plugin loading completed',
            failureMessage: 'Plugin loading failed; retry later',
          },
        );
        return;
      case 'ntp-initial-check':
        await bootstrapCoordinator.runPhase(
          phaseId,
          () => digitalRadioEngine.getNtpCalibrationService().start(),
          {
            timeoutMs: 10_000,
            pendingMessage: 'Restarting clock calibration',
            successMessage: 'Clock calibration service started',
            failureMessage: 'Clock calibration service failed to start; retry later',
          },
        );
        return;
      case 'active-profile-autostart':
        if (ConfigManager.getInstance().getActiveProfileId() === null) {
          bootstrapCoordinator.skipPhase(phaseId, 'No active profile; auto-start skipped');
          return;
        }
        await bootstrapCoordinator.runPhase(
          phaseId,
          () => digitalRadioEngine.start(),
          {
            timeoutMs: 15_000,
            pendingMessage: 'Retrying radio auto-start',
            successMessage: 'Radio auto-start completed',
            failureMessage: 'Radio auto-start failed; retry later',
          },
        );
        return;
      default:
        logger.warn('Unsupported bootstrap retry phase ignored', { phaseId });
    }
  };

  void run().catch((error) => {
    logger.warn('Bootstrap phase retry failed', {
      phaseId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function getConfiguredWebPort(): number {
  const raw = process.env.WEB_PORT || process.env.TX5DR_WEB_DEV_PORT || '8076';
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 8076;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

function buildAllowedBrowserOrigins(): Set<string> {
  const webPort = getConfiguredWebPort();
  const accessInfo = getNetworkAccessInfo({ webPort });
  const hostnames = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '[::1]',
    accessInfo.hostname,
    ...accessInfo.addresses.map(address => address.ip),
  ].filter(Boolean));
  const origins = new Set<string>();

  for (const hostname of hostnames) {
    const host = hostname === '::1' ? '[::1]' : hostname;
    origins.add(`http://${host}:${webPort}`);
    origins.add(`https://${host}:${webPort}`);
  }

  return origins;
}

export function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (!origin) return true;

  try {
    const parsed = new URL(origin);
    if (isLoopbackHostname(parsed.hostname)) {
      return true;
    }
    return buildAllowedBrowserOrigins().has(parsed.origin);
  } catch {
    return false;
  }
}

export async function registerRoleScope(
  fastify: FastifyInstance,
  minRole: UserRole,
  registerRoutes: (scope: FastifyInstance) => Promise<void>,
): Promise<void> {
  await fastify.register(async (scope) => {
    scope.addHook('onRequest', requireRole(minRole));
    await registerRoutes(scope);
  });
}

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
  bootstrapCoordinator.startPhase('config-auth', 'Reading base configuration');
  await configManager.initialize();
  fastify.log.info('Config manager initialized');

  bootstrapCoordinator.startPhase('audio-device-discovery', 'Discovering audio devices');
  await AudioDeviceManager.getInstance().initializeDeviceRegistry();
  bootstrapCoordinator.completePhase('audio-device-discovery');
  fastify.log.info('Audio device registry initialized');

  // 初始化认证管理器
  const authManager = AuthManager.getInstance();
  await authManager.initialize();
  const deviceServiceAuthManager = DeviceServiceAuthManager.getInstance();
  await deviceServiceAuthManager.initialize();
  bootstrapCoordinator.completePhase('config-auth');
  fastify.log.info('Auth manager initialized');

  // 注册认证插件（全局 JWT 验证）
  await fastify.register(authPlugin);
  fastify.log.info('Auth plugin registered');

  fastify.addHook('onRequest', async (request, reply) => {
    const method = request.method.toUpperCase();
    const isMutation = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    const isInternalShutdown = request.url.startsWith('/api/system/internal/prepare-shutdown');
    if (isMutation && !isInternalShutdown && areNewMutationsBlocked()) {
      return reply.code(503).send({
        success: false,
        error: {
          code: 'SERVER_SHUTTING_DOWN',
          message: 'Server is shutting down; new writes are temporarily blocked',
        },
      });
    }
  });

  // 初始化数字无线电引擎
  bootLogger.info('initializing digital radio engine...');
  ConsoleLogger.getInstance().flushSync();
  const digitalRadioEngine = DigitalRadioEngine.getInstance();
  bootstrapCoordinator.startPhase('engine-bootstrap', 'Assembling radio engine');
  await digitalRadioEngine.initialize();
  bootstrapCoordinator.completePhase('engine-bootstrap');
  bootLogger.info('digital radio engine initialized');
  ConsoleLogger.getInstance().flushSync();

  fastify.addHook('onClose', async () => {
    await digitalRadioEngine.pluginManager.shutdown();
  });

  // 初始化进程监控（独立于引擎，始终运行）
  const processMonitor = ProcessMonitor.getInstance();
  processMonitor.setExtraSnapshotProvider(() => ({
    decodeWorkers: digitalRadioEngine.getDecodeWorkerTelemetrySnapshot(),
    workerPools: digitalRadioEngine.getWorkerPoolTelemetrySnapshots(),
  }));
  processMonitor.start();

  // 初始化实时音频路由器（统一音频数据面）
  const realtimeRxAudioRouter = new RealtimeRxAudioRouter(
    digitalRadioEngine.getAudioStreamManager(),
  );
  bootLogger.info('starting realtime audio transport manager...');
  const realtimeTransportManager = RealtimeTransportManager.initialize(
    digitalRadioEngine,
    realtimeRxAudioRouter,
  );
  fastify.addHook('onClose', async () => {
    realtimeRxAudioRouter.dispose();
  });
  bootLogger.info('realtime audio transport manager started');

  // 初始化WebSocket服务器（集成业务逻辑）
  const wsServer = new WSServer(digitalRadioEngine, processMonitor);
  const logbookWsServer = new LogbookWSServer(digitalRadioEngine);
  const deviceUiWsServer = new DeviceUiWSServer(digitalRadioEngine, deviceServiceAuthManager);
  fastify.log.info('WebSocket server initialized');

  // Register CORS plugin. Keep localhost/same-host web access, but do not
  // reflect arbitrary browser origins while credentials are enabled.
  await fastify.register(cors, {
    origin: (origin, callback) => {
      callback(null, isAllowedCorsOrigin(origin) ? (origin ?? false) : false);
    },
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

  fastify.get('/api/system/bootstrap-status', async (_request, reply) => {
    return reply.send(bootstrapCoordinator.getStatus());
  });

  fastify.post<{ Body: { phaseId?: BootstrapPhaseId } }>(
    '/api/system/bootstrap-status/retry',
    { preHandler: [requireRole(UserRole.ADMIN)] },
    async (request, reply) => {
      const status = bootstrapCoordinator.getStatus();
      if (status.lifecycle === 'completed' || status.lifecycle === 'dismissed') {
        return reply.send(status);
      }

      const requestedPhaseId = request.body?.phaseId;
      const phaseIds = requestedPhaseId
        ? [requestedPhaseId]
        : status.phases
          .filter(phase => phase.retryable && ['failed', 'timed_out', 'warning'].includes(phase.state))
          .map(phase => phase.id);

      const unsupported = phaseIds.find(phaseId => !RETRYABLE_BOOTSTRAP_PHASES.has(phaseId));
      if (unsupported) {
        return reply.code(400).send({
          success: false,
          error: { code: 'UNSUPPORTED_BOOTSTRAP_RETRY', message: `Bootstrap phase ${unsupported} cannot be retried` },
        });
      }

      for (const phaseId of phaseIds) {
        retryBootstrapPhase(phaseId, digitalRadioEngine);
      }

      return reply.code(202).send(bootstrapCoordinator.getStatus());
    },
  );

  fastify.post('/api/system/internal/prepare-shutdown', async (request, reply) => {
    const startedAt = Date.now();
    const expectedToken = process.env.TX5DR_INTERNAL_SHUTDOWN_TOKEN;
    const providedToken = Array.isArray(request.headers['x-tx5dr-internal-token'])
      ? request.headers['x-tx5dr-internal-token'][0]
      : request.headers['x-tx5dr-internal-token'];

    if (!safeTokenEquals(providedToken, expectedToken)) {
      return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
    }

    markProcessShuttingDown();
    blockNewMutations();
    PersistenceCoordinator.getInstance().blockNewMutations();

    try {
      if (digitalRadioEngine.getStatus().isRunning) {
        await Promise.race([
          digitalRadioEngine.stop(),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('engine stop timeout')), Math.min(
              INTERNAL_ENGINE_STOP_TIMEOUT_MS,
              remainingDeadlineMs(startedAt, INTERNAL_PREPARE_SHUTDOWN_DEADLINE_MS),
            ));
          }),
        ]);
      }
    } catch (error) {
      fastify.log.warn({ error }, 'engine stop failed during internal prepare-shutdown');
    }

    try {
      await digitalRadioEngine.operatorManager.getLogManager().close();
    } catch (error) {
      fastify.log.warn({ error }, 'logbook close failed during internal prepare-shutdown');
    }

    const flushResult = await PersistenceCoordinator.getInstance().flushAll({
      reason: 'internal-prepare-shutdown',
      deadlineMs: remainingDeadlineMs(startedAt, INTERNAL_PREPARE_SHUTDOWN_DEADLINE_MS),
    });

    return reply.code(flushResult.ok ? 200 : 500).send({
      success: flushResult.ok,
      errors: flushResult.errors,
    });
  });

  // ===== 路由注册（带权限保护） =====
  bootLogger.info('registering routes...');
  ConsoleLogger.getInstance().flushSync();

  // Profile 列表是角色感知的：Admin 完整，其他身份脱敏；写操作在路由内单独要求 Admin。
  await fastify.register(profileRoutes, { prefix: '/api/profiles' });
  fastify.log.info('Profile routes registered');

  // Admin 路由：音频、设置、存储、第三方服务
  await registerRoleScope(fastify, UserRole.ADMIN, async (scope) => {
    await scope.register(audioRoutes, { prefix: '/api/audio' });
    await scope.register(settingsRoutes, { prefix: '/api/settings' });
    const { storageRoutes } = await import('./routes/storage.js');
    await scope.register(storageRoutes, { prefix: '/api/storage' });
    const { pskreporterRoutes } = await import('./routes/pskreporter.js');
    await scope.register(pskreporterRoutes, { prefix: '/api' });
    await scope.register(systemRoutes, { prefix: '/api/system' });
    await scope.register(openwebrxRoutes, { prefix: '/api/openwebrx' });
  });
  fastify.log.info('Admin routes registered (audio, settings, storage, pskreporter, system, openwebrx)');

  // Viewer+ 路由：操作员（内部根据角色过滤）、电台状态、模式、时隙包、语音
  await registerRoleScope(fastify, UserRole.VIEWER, async (scope) => {
    await scope.register(operatorRoutes, { prefix: '/api/operators' });
    await scope.register(radioRoutes, { prefix: '/api/radio' });
    await scope.register(powerRoutes, { prefix: '/api/radio/power' });
    await scope.register(rigctldRoutes, { prefix: '/api/rigctld' });
    await scope.register(modeRoutes, { prefix: '/api/mode' });
    await scope.register(slotpackRoutes, { prefix: '/api/slotpack' });
    await scope.register(voiceRoutes, { prefix: '/api/voice' });
    await scope.register(cwRoutes, { prefix: '/api/cw' });
    await scope.register(callsignRoutes, { prefix: '/api/callsigns' });
  });
  fastify.log.info('Viewer+ routes registered (operators, radio, mode, slotpack, voice, callsigns)');

  // Operator+ 路由：日志本（细粒度权限由路由内部 preHandler 控制）
  await registerRoleScope(fastify, UserRole.OPERATOR, async (scope) => {
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

  // Device UI 路由：health/session/bootstrap 自行处理 device JWT，不进入普通用户角色保护。
  await fastify.register(deviceUiRoutes, {
    prefix: '/api/device-ui',
    projectionService: deviceUiWsServer.getProjectionService(),
    authManager: deviceServiceAuthManager,
  });
  fastify.log.info('Device UI routes registered');

  // 实时音频会话
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

  // Device UI 专用 WebSocket：使用 device JWT，独立于普通浏览器 WSServer/clientHandshake。
  fastify.get('/api/device-ui/ws', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    await deviceUiWsServer.acceptConnection(socket, req);
  });

  // 服务器关闭时清理WebSocket连接
  fastify.addHook('onClose', async () => {
    processMonitor.stop();
    wsServer.cleanup();
    logbookWsServer.cleanup();
    deviceUiWsServer.cleanup();
  });

  fastify.get('/api/realtime/ws-compat', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    realtimeTransportManager.acceptCompatConnection(socket, req.url);
  });

  fastify.get('/api/realtime/rtc-data-audio', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    realtimeTransportManager.acceptRtcDataAudioConnection(socket, req.url);
  });

  return fastify;
}
