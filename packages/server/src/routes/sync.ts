/* eslint-disable @typescript-eslint/no-explicit-any */
// SyncRoutes - API响应处理需要使用any

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SyncRoute');
import {
  CallsignSyncConfigSchema,
  WaveLogConfig,
  WaveLogConfigSchema,
  WaveLogTestConnectionRequestSchema,
  WaveLogSyncRequestSchema,
  QRZConfig,
  QRZConfigSchema,
  QRZTestConnectionRequestSchema,
  QRZSyncRequestSchema,
  LoTWConfig,
  LoTWConfigSchema,
  LoTWTestConnectionRequestSchema,
  LoTWTQSLDetectRequestSchema,
  LoTWSyncRequestSchema,
} from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { SyncServiceRegistry } from '../services/SyncServiceRegistry.js';
import { WaveLogService } from '../services/WaveLogService.js';
import { QRZService } from '../services/QRZService.js';
import { LoTWService } from '../services/LoTWService.js';
import { LogManager } from '../log/LogManager.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';
import { requireCallsignAccess } from '../auth/authPlugin.js';

/**
 * 通用：根据呼号和时间范围在本地日志本中查找匹配的 QSO
 */
async function findMatchingLocalQSO(
  callsign: string,
  startTime: number,
  logManager: LogManager
): Promise<{ qsoId: string; logBookProvider: any } | null> {
  const logBooks = logManager.getLogBooks();
  // 允许 ±30 秒的时间偏差
  const timeTolerance = 30000;

  for (const logBook of logBooks) {
    try {
      const matches = await logBook.provider.queryQSOs({
        callsign,
        timeRange: {
          start: startTime - timeTolerance,
          end: startTime + timeTolerance,
        },
        limit: 5,
      });
      // 精确匹配呼号
      const exact = matches.find(
        (q: any) => q.callsign.toUpperCase() === callsign.toUpperCase()
      );
      if (exact) {
        return { qsoId: exact.id, logBookProvider: logBook.provider };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * 通用：批量标记本地 QSO 的上传状态
 */
async function markQSOsAsSent(
  qsos: any[],
  platform: 'lotw' | 'qrz',
  logManager: LogManager
): Promise<number> {
  let marked = 0;
  const now = Date.now();
  for (const qso of qsos) {
    const match = await findMatchingLocalQSO(qso.callsign, qso.startTime, logManager);
    if (match) {
      try {
        const updates: any = {};
        if (platform === 'lotw') {
          updates.lotwQslSent = 'Y';
          updates.lotwQslSentDate = now;
        } else {
          updates.qrzQslSent = 'Y';
          updates.qrzQslSentDate = now;
        }
        await match.logBookProvider.updateQSO(match.qsoId, updates);
        marked++;
      } catch {
        // ignore individual failures
      }
    }
  }
  return marked;
}

/**
 * 通用：获取本地 QSO 记录（最近一周，最多 1000 条）
 */
async function getRecentQSOs() {
  const logManager = LogManager.getInstance();
  const logBooks = logManager.getLogBooks();

  if (logBooks.length === 0) return [];

  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const allQSOs: any[] = [];

  for (const logBook of logBooks) {
    try {
      const qsos = await logBook.provider.queryQSOs({
        timeRange: { start: oneWeekAgo, end: Date.now() },
        limit: 1000,
      });
      allQSOs.push(...qsos);
    } catch (error) {
      logger.warn(`Failed to get QSO records from log book ${logBook.name}:`, error);
    }
  }

  return allQSOs;
}

/**
 * 同步路由
 * 前缀: /api/sync
 */
export async function syncRoutes(fastify: FastifyInstance) {
  const configManager = ConfigManager.getInstance();
  const registry = SyncServiceRegistry.getInstance();
  const callsignAccess = requireCallsignAccess();

  // =====================
  // GET /callsigns — 列出所有已配置同步的呼号
  // =====================
  fastify.get('/callsigns', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allConfigs = configManager.getAllCallsignSyncConfigs();
      const callsigns = Object.keys(allConfigs);
      return reply.send({ success: true, callsigns });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // =====================
  // GET /:callsign/config — 获取指定呼号的全部同步配置
  // =====================
  fastify.get('/:callsign/config', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const config = configManager.getCallsignSyncConfig(callsign);
      if (!config) {
        return reply.send({ success: true, config: { callsign: callsign.toUpperCase().trim() } });
      }
      return reply.send({ success: true, config });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // =====================
  // PUT /:callsign/config — 更新指定呼号的全部同步配置
  // =====================
  fastify.put('/:callsign/config', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const updates = CallsignSyncConfigSchema.partial().parse(request.body);
      await configManager.updateCallsignSyncConfig(callsign, updates);

      // 更新服务注册表
      const newConfig = configManager.getCallsignSyncConfig(callsign);
      if (newConfig) {
        registry.updateServicesForCallsign(callsign, newConfig);
      }

      return reply.send({ success: true, config: newConfig });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // =====================
  // GET /:callsign/summary — 获取同步摘要
  // =====================
  fastify.get('/:callsign/summary', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const summary = configManager.getCallsignSyncSummary(callsign);
      return reply.send({ success: true, summary });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // =============================================
  //  WaveLog 子路由
  // =============================================

  // GET /:callsign/wavelog/config
  fastify.get('/:callsign/wavelog/config', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const config = configManager.getCallsignSyncConfig(callsign);
      return reply.send({ success: true, config: config?.wavelog || null });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // PUT /:callsign/wavelog/config
  fastify.put('/:callsign/wavelog/config', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const wavelogUpdates = WaveLogConfigSchema.partial().parse(request.body);
      const existing = configManager.getCallsignSyncConfig(callsign);
      const mergedWavelog = { ...(existing?.wavelog || {}), ...wavelogUpdates } as WaveLogConfig;
      await configManager.updateCallsignSyncConfig(callsign, { wavelog: mergedWavelog });

      // 更新服务注册表
      const newConfig = configManager.getCallsignSyncConfig(callsign);
      if (newConfig) {
        registry.updateServicesForCallsign(callsign, newConfig);
      }

      return reply.send({ success: true, config: newConfig?.wavelog });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // POST /:callsign/wavelog/test
  fastify.post('/:callsign/wavelog/test', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const testRequest = WaveLogTestConnectionRequestSchema.parse(request.body);
      const testConfig: WaveLogConfig = {
        url: testRequest.url,
        apiKey: testRequest.apiKey,
        stationId: '',
        radioName: 'TX5DR',
        autoUploadQSO: true,
      };

      const testService = new WaveLogService(testConfig);
      const result = await testService.testConnection();
      return reply.send(result);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.CONNECTION_FAILED);
    }
  });

  // POST /:callsign/wavelog/sync
  fastify.post('/:callsign/wavelog/sync', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const syncRequest = WaveLogSyncRequestSchema.parse(request.body);

      const service = registry.getWaveLogService(callsign);
      if (!service) {
        throw new RadioError({
          code: RadioErrorCode.NOT_INITIALIZED,
          message: `WaveLog service for callsign ${callsign} not initialized`,
          userMessage: 'Please configure WaveLog settings for this callsign first',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['Configure WaveLog URL and API key in sync settings page', 'Ensure WaveLog service is enabled'],
        });
      }

      let result;

      switch (syncRequest.operation) {
        case 'download': {
          // 手动触发下载同步 — 复用 WaveLogSyncScheduler 逻辑
          const { WaveLogSyncScheduler } = await import('../services/WaveLogSyncScheduler.js');
          const syncScheduler = WaveLogSyncScheduler.getInstance();
          result = await syncScheduler.triggerSync(service, callsign);
          break;
        }
        case 'upload': {
          const allQSOs = await getRecentQSOs();
          if (allQSOs.length === 0) {
            result = {
              success: true,
              message: 'No QSO records found to upload',
              uploadedCount: 0, downloadedCount: 0, skippedCount: 0, errorCount: 0,
              syncTime: Date.now(),
            };
          } else {
            logger.debug(`Uploading ${allQSOs.length} QSOs to WaveLog (${callsign})`);
            result = await service.uploadMultipleQSOs(allQSOs);
          }
          break;
        }
        case 'full_sync': {
          const { WaveLogSyncScheduler } = await import('../services/WaveLogSyncScheduler.js');
          const syncScheduler = WaveLogSyncScheduler.getInstance();
          const downloadResult = await syncScheduler.triggerSync(service, callsign);

          const qsos = await getRecentQSOs();
          let uploadResult: any = { success: true, message: 'No QSOs', uploadedCount: 0, skippedCount: 0, errorCount: 0, errors: [] };
          if (qsos.length > 0) {
            uploadResult = await service.uploadMultipleQSOs(qsos);
          }

          result = {
            success: downloadResult.success && uploadResult.success,
            message: `Full sync complete - download: ${downloadResult.message}, upload: ${uploadResult.message}`,
            uploadedCount: uploadResult.uploadedCount,
            downloadedCount: downloadResult.downloadedCount,
            skippedCount: downloadResult.skippedCount + uploadResult.skippedCount,
            errorCount: downloadResult.errorCount + uploadResult.errorCount,
            errors: [...(downloadResult.errors || []), ...(uploadResult.errors || [])],
            syncTime: Date.now(),
          };
          break;
        }
        default:
          throw new RadioError({
            code: RadioErrorCode.INVALID_OPERATION,
            message: `Unsupported sync operation type: ${syncRequest.operation}`,
            userMessage: 'Unsupported sync operation type',
            severity: RadioErrorSeverity.WARNING,
            suggestions: ['Supported operation types: download, upload, full_sync'],
          });
      }

      return reply.send(result);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // GET /:callsign/wavelog/status
  fastify.get('/:callsign/wavelog/status', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const config = configManager.getCallsignSyncConfig(callsign);
      const wavelogConfig = config?.wavelog;
      const service = registry.getWaveLogService(callsign);

      return reply.send({
        configured: !!(wavelogConfig?.url && wavelogConfig?.apiKey && wavelogConfig?.stationId),
        serviceAvailable: !!service,
        lastSyncTime: wavelogConfig?.lastSyncTime,
        autoUpload: wavelogConfig?.autoUploadQSO,
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // =============================================
  //  QRZ 子路由
  // =============================================

  // GET /:callsign/qrz/config
  fastify.get('/:callsign/qrz/config', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const config = configManager.getCallsignSyncConfig(callsign);
      return reply.send({ success: true, config: config?.qrz || null });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // PUT /:callsign/qrz/config
  fastify.put('/:callsign/qrz/config', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const qrzUpdates = QRZConfigSchema.partial().parse(request.body);
      const existing = configManager.getCallsignSyncConfig(callsign);
      const mergedQrz = { ...(existing?.qrz || {}), ...qrzUpdates } as QRZConfig;
      await configManager.updateCallsignSyncConfig(callsign, { qrz: mergedQrz });

      const newConfig = configManager.getCallsignSyncConfig(callsign);
      if (newConfig) {
        registry.updateServicesForCallsign(callsign, newConfig);
      }

      return reply.send({ success: true, config: newConfig?.qrz });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // POST /:callsign/qrz/test
  fastify.post('/:callsign/qrz/test', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const testRequest = QRZTestConnectionRequestSchema.parse(request.body);
      const testConfig: QRZConfig = {
        apiKey: testRequest.apiKey,
        autoUploadQSO: false,
      };

      const testService = new QRZService(testConfig);
      const result = await testService.testConnection();
      return reply.send(result);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.CONNECTION_FAILED);
    }
  });

  // POST /:callsign/qrz/sync
  fastify.post('/:callsign/qrz/sync', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const syncRequest = QRZSyncRequestSchema.parse(request.body);

      const service = registry.getQRZService(callsign);
      if (!service) {
        throw new RadioError({
          code: RadioErrorCode.NOT_INITIALIZED,
          message: `QRZ service for callsign ${callsign} not initialized`,
          userMessage: 'Please configure QRZ settings for this callsign first',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['Configure QRZ API key in sync settings page', 'Ensure QRZ service is enabled'],
        });
      }

      let result;

      switch (syncRequest.operation) {
        case 'download': {
          const qsos = await service.downloadQSOs();
          result = {
            success: true,
            message: `Download complete: ${qsos.length} QSO records`,
            uploadedCount: 0, downloadedCount: qsos.length, skippedCount: 0, errorCount: 0,
            syncTime: Date.now(),
          };
          break;
        }
        case 'upload': {
          const allQSOs = await getRecentQSOs();
          if (allQSOs.length === 0) {
            result = {
              success: true,
              message: 'No QSO records found to upload',
              uploadedCount: 0, downloadedCount: 0, skippedCount: 0, errorCount: 0,
              syncTime: Date.now(),
            };
          } else {
            logger.debug(`Uploading ${allQSOs.length} QSOs to QRZ (${callsign})`);
            result = await service.uploadMultipleQSOs(allQSOs);
            // 上传成功后标记本地 QSO 的 qrzQslSent
            if (result.success && result.uploadedCount > 0) {
              const logManager = LogManager.getInstance();
              const markedCount = await markQSOsAsSent(allQSOs, 'qrz', logManager);
              logger.info(`Marked ${markedCount} QSOs as QRZ sent`);
            }
          }
          break;
        }
        case 'full_sync': {
          let downloadedCount = 0;
          const downloadErrors: string[] = [];

          try {
            const qsos = await service.downloadQSOs();
            downloadedCount = qsos.length;
          } catch (error) {
            downloadErrors.push(error instanceof Error ? error.message : 'Download failed');
          }

          const allQSOs = await getRecentQSOs();
          let uploadResult: any = { success: true, message: 'No QSOs', uploadedCount: 0, skippedCount: 0, errorCount: 0, errors: [] };
          if (allQSOs.length > 0) {
            uploadResult = await service.uploadMultipleQSOs(allQSOs);
            // 上传成功后标记本地 QSO 的 qrzQslSent
            if (uploadResult.success && uploadResult.uploadedCount > 0) {
              const logManager = LogManager.getInstance();
              await markQSOsAsSent(allQSOs, 'qrz', logManager);
            }
          }

          result = {
            success: downloadErrors.length === 0 && uploadResult.success,
            message: `Full sync complete - downloaded: ${downloadedCount}, upload: ${uploadResult.message}`,
            uploadedCount: uploadResult.uploadedCount,
            downloadedCount,
            skippedCount: uploadResult.skippedCount,
            errorCount: uploadResult.errorCount + downloadErrors.length,
            errors: [...downloadErrors, ...(uploadResult.errors || [])],
            syncTime: Date.now(),
          };
          break;
        }
        default:
          throw new RadioError({
            code: RadioErrorCode.INVALID_OPERATION,
            message: `Unsupported sync operation type: ${syncRequest.operation}`,
            userMessage: 'Unsupported sync operation type',
            severity: RadioErrorSeverity.WARNING,
            suggestions: ['Supported operation types: download, upload, full_sync'],
          });
      }

      return reply.send(result);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // GET /:callsign/qrz/status
  fastify.get('/:callsign/qrz/status', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const config = configManager.getCallsignSyncConfig(callsign);
      const qrzConfig = config?.qrz;
      const service = registry.getQRZService(callsign);

      return reply.send({
        configured: !!qrzConfig?.apiKey,
        serviceAvailable: !!service,
        lastSyncTime: qrzConfig?.lastSyncTime,
        autoUpload: qrzConfig?.autoUploadQSO,
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // =============================================
  //  LoTW 子路由
  // =============================================

  // GET /:callsign/lotw/config
  fastify.get('/:callsign/lotw/config', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const config = configManager.getCallsignSyncConfig(callsign);
      return reply.send({ success: true, config: config?.lotw || null });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // PUT /:callsign/lotw/config
  fastify.put('/:callsign/lotw/config', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const lotwUpdates = LoTWConfigSchema.partial().parse(request.body);
      const existing = configManager.getCallsignSyncConfig(callsign);
      const mergedLotw = { ...(existing?.lotw || {}), ...lotwUpdates } as LoTWConfig;
      await configManager.updateCallsignSyncConfig(callsign, { lotw: mergedLotw });

      const newConfig = configManager.getCallsignSyncConfig(callsign);
      if (newConfig) {
        registry.updateServicesForCallsign(callsign, newConfig);
      }

      return reply.send({ success: true, config: newConfig?.lotw });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // POST /:callsign/lotw/test
  fastify.post('/:callsign/lotw/test', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const testRequest = LoTWTestConnectionRequestSchema.parse(request.body);
      const testConfig: LoTWConfig = {
        username: testRequest.username,
        password: testRequest.password,
        tqslPath: '',
        stationCallsign: '',
        autoUploadQSO: false,
      };

      const testService = new LoTWService(testConfig);
      const result = await testService.testConnection();
      return reply.send(result);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.CONNECTION_FAILED);
    }
  });

  // POST /:callsign/lotw/detect-tqsl
  fastify.post('/:callsign/lotw/detect-tqsl', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const detectRequest = LoTWTQSLDetectRequestSchema.parse(request.body);

      // 使用注册表中的服务或创建临时实例
      const existingService = registry.getLoTWService(callsign);
      const config = configManager.getCallsignSyncConfig(callsign);
      const service = existingService || new LoTWService(config?.lotw || {
        username: '',
        password: '',
        tqslPath: '',
        stationCallsign: '',
        autoUploadQSO: false,
      });
      const result = await service.detectTQSL(detectRequest.tqslPath);

      // 如果检测到TQSL，自动保存路径到配置
      if (result.found && result.path) {
        const existing = configManager.getCallsignSyncConfig(callsign);
        const mergedLotw = { ...(existing?.lotw || {}), tqslPath: result.path } as LoTWConfig;
        await configManager.updateCallsignSyncConfig(callsign, { lotw: mergedLotw });
        const newConfig = configManager.getCallsignSyncConfig(callsign);
        if (newConfig) {
          registry.updateServicesForCallsign(callsign, newConfig);
        }
      }

      return reply.send(result);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // POST /:callsign/lotw/sync
  fastify.post('/:callsign/lotw/sync', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const syncRequest = LoTWSyncRequestSchema.parse(request.body);

      const service = registry.getLoTWService(callsign);
      if (!service) {
        throw new RadioError({
          code: RadioErrorCode.NOT_INITIALIZED,
          message: `LoTW service for callsign ${callsign} not initialized`,
          userMessage: 'Please configure LoTW settings for this callsign first',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['Configure LoTW username and password in sync settings page', 'Ensure LoTW service is enabled'],
        });
      }

      let result;

      switch (syncRequest.operation) {
        case 'upload': {
          const allQSOs = await getRecentQSOs();
          if (allQSOs.length === 0) {
            result = {
              success: true,
              message: 'No QSO records found to upload',
              uploadedCount: 0, downloadedCount: 0, confirmedCount: 0, errorCount: 0,
              syncTime: Date.now(),
            };
          } else {
            logger.debug(`Uploading ${allQSOs.length} QSOs to LoTW (${callsign})`);
            result = await service.uploadQSOs(allQSOs);
            // 上传成功后标记本地 QSO 的 lotwQslSent
            if (result.success && result.uploadedCount > 0) {
              const logManager = LogManager.getInstance();
              const markedCount = await markQSOsAsSent(allQSOs, 'lotw', logManager);
              logger.info(`Marked ${markedCount} QSOs as LoTW sent`);
            }
          }
          break;
        }

        case 'download_confirmations': {
          const { records, confirmedCount } = await service.downloadConfirmations(syncRequest.since);
          // 将确认状态回写到本地 QSO
          const logManager = LogManager.getInstance();
          let updatedCount = 0;
          for (const record of records) {
            const match = await findMatchingLocalQSO(record.callsign, record.startTime, logManager);
            if (match) {
              try {
                const updates: any = {
                  lotwQslReceived: record.lotwQslReceived || 'Y',
                  lotwQslReceivedDate: record.lotwQslReceivedDate || Date.now(),
                };
                // 同时标记 sent（确认的前提是已上传）
                if (!record.lotwQslSent) {
                  updates.lotwQslSent = 'Y';
                }
                await match.logBookProvider.updateQSO(match.qsoId, updates);
                updatedCount++;
              } catch {
                // ignore individual failures
              }
            }
          }
          logger.info(`LoTW confirmation write-back: ${updatedCount}/${records.length} QSOs updated`);
          result = {
            success: true,
            message: `Downloaded ${confirmedCount} LoTW confirmation records, updated ${updatedCount} local QSOs`,
            uploadedCount: 0,
            downloadedCount: records.length,
            confirmedCount: updatedCount,
            errorCount: 0,
            syncTime: Date.now(),
          };
          break;
        }

        default:
          throw new RadioError({
            code: RadioErrorCode.INVALID_OPERATION,
            message: `Unsupported sync operation type: ${(syncRequest as any).operation}`,
            userMessage: 'Unsupported sync operation type',
            severity: RadioErrorSeverity.WARNING,
            suggestions: ['Supported operation types: upload, download_confirmations'],
          });
      }

      return reply.send(result);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // GET /:callsign/lotw/status
  fastify.get('/:callsign/lotw/status', { preHandler: [callsignAccess] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { callsign } = request.params as { callsign: string };
      const config = configManager.getCallsignSyncConfig(callsign);
      const lotwConfig = config?.lotw;
      const service = registry.getLoTWService(callsign);

      return reply.send({
        configured: !!(lotwConfig?.username && lotwConfig?.password),
        tqslConfigured: !!lotwConfig?.tqslPath,
        serviceAvailable: !!service,
        lastUploadTime: lotwConfig?.lastUploadTime,
        lastDownloadTime: lotwConfig?.lastDownloadTime,
        autoUpload: lotwConfig?.autoUploadQSO,
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
}
