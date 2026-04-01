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
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';
import { requireCallsignAccess } from '../auth/authPlugin.js';
import { normalizeCallsign } from '../utils/callsign.js';
import { getBandFromFrequency, type ILogProvider } from '@tx5dr/core';

/**
 * LoTW 匹配允许 LoTW 返回的分钟级时间与本地秒级时间存在偏差。
 */
const LOTW_TIME_TOLERANCE_MS = 2 * 60 * 1000;
const LOTW_FREQUENCY_TOLERANCE_HZ = 3000;

async function getTargetLogBook(
  callsign: string,
  logManager: LogManager
): Promise<{ id: string; provider: ILogProvider; operatorId?: string }> {
  const logBook = await logManager.getOrCreateLogBookByCallsign(callsign);
  const operatorId = logManager.getOperatorIdsForLogBook(logBook.id)[0];
  return {
    id: logBook.id,
    provider: logBook.provider,
    operatorId,
  };
}

/**
 * 仅在当前呼号所属日志本内查找最可能的本地 QSO，避免跨日志本误写。
 */
async function findMatchingLocalQSO(
  provider: ILogProvider,
  remoteQSO: any
): Promise<any | null> {
  const matches = await provider.queryQSOs({
    callsign: remoteQSO.callsign,
    timeRange: {
      start: remoteQSO.startTime - LOTW_TIME_TOLERANCE_MS,
      end: remoteQSO.startTime + LOTW_TIME_TOLERANCE_MS,
    },
    limit: 20,
  });

  const normalizedCallsign = remoteQSO.callsign.toUpperCase();
  const normalizedMode = remoteQSO.mode?.toUpperCase();
  const remoteBand = remoteQSO.frequency ? getBandFromFrequency(remoteQSO.frequency) : undefined;

  const candidates = matches
    .filter((qso: any) => qso.callsign.toUpperCase() === normalizedCallsign)
    .filter((qso: any) => {
      if (!normalizedMode || !qso.mode) return true;
      return qso.mode.toUpperCase() === normalizedMode;
    })
    .filter((qso: any) => {
      if (!remoteQSO.frequency || !qso.frequency) return true;
      if (Math.abs(qso.frequency - remoteQSO.frequency) <= LOTW_FREQUENCY_TOLERANCE_HZ) {
        return true;
      }
      if (!remoteBand) return false;
      return getBandFromFrequency(qso.frequency) === remoteBand;
    })
    .sort((left: any, right: any) => {
      const leftTimeDiff = Math.abs(left.startTime - remoteQSO.startTime);
      const rightTimeDiff = Math.abs(right.startTime - remoteQSO.startTime);
      if (leftTimeDiff !== rightTimeDiff) {
        return leftTimeDiff - rightTimeDiff;
      }
      const leftFreqDiff = Math.abs((left.frequency || 0) - (remoteQSO.frequency || 0));
      const rightFreqDiff = Math.abs((right.frequency || 0) - (remoteQSO.frequency || 0));
      return leftFreqDiff - rightFreqDiff;
    });

  return candidates[0] || null;
}

/**
 * 对上传成功的本地记录回写 LoTW sent 状态。
 */
async function markLotwUploadSent(
  provider: ILogProvider,
  qsos: any[]
): Promise<number> {
  let updatedCount = 0;
  const now = Date.now();

  for (const qso of qsos) {
    try {
      await provider.updateQSO(qso.id, {
        lotwQslSent: 'Y',
        lotwQslSentDate: qso.lotwQslSentDate || now,
      });
      updatedCount++;
    } catch (error) {
      logger.warn('Failed to mark QSO as LoTW sent', { qsoId: qso.id, error });
    }
  }

  return updatedCount;
}

async function markQSOsAsSent(
  qsos: any[],
  platform: 'lotw' | 'qrz',
  logManager: LogManager
): Promise<number> {
  let marked = 0;
  const now = Date.now();

  for (const qso of qsos) {
    const logBooks = logManager.getLogBooks();
    for (const logBook of logBooks) {
      try {
        const match = await findMatchingLocalQSO(logBook.provider, qso);
        if (!match) {
          continue;
        }

        const updates: any = platform === 'lotw'
          ? { lotwQslSent: 'Y', lotwQslSentDate: qso.lotwQslSentDate || now }
          : { qrzQslSent: 'Y', qrzQslSentDate: qso.qrzQslSentDate || now };

        await logBook.provider.updateQSO(match.id, updates);
        marked++;
        break;
      } catch {
        // ignore individual failures
      }
    }
  }

  return marked;
}

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
      logger.warn(`Failed to get QSO records from log book ${logBook.id}:`, error);
    }
  }

  return allQSOs;
}

function buildLotwWriteBackUpdates(record: any, existing?: any) {
  const now = Date.now();
  return {
    lotwQslReceived: record.lotwQslReceived || existing?.lotwQslReceived || 'Y',
    lotwQslReceivedDate: record.lotwQslReceivedDate || existing?.lotwQslReceivedDate || now,
    lotwQslSent: record.lotwQslSent || existing?.lotwQslSent || 'Y',
    lotwQslSentDate: record.lotwQslSentDate || existing?.lotwQslSentDate || now,
  };
}

function getChangedLotwWriteBackUpdates(record: any, existing?: any) {
  const desiredUpdates = buildLotwWriteBackUpdates(record, existing);
  const changedUpdates: Record<string, any> = {};

  for (const [key, value] of Object.entries(desiredUpdates)) {
    if (value !== undefined && existing?.[key] !== value) {
      changedUpdates[key] = value;
    }
  }

  return changedUpdates;
}

function resolveLotwConfirmationSince(
  explicitSince: string | undefined,
  lastDownloadTime: number | undefined
): string | undefined {
  if (explicitSince) {
    return explicitSince;
  }
  if (typeof lastDownloadTime !== 'number' || Number.isNaN(lastDownloadTime)) {
    return undefined;
  }

  return new Date(lastDownloadTime).toISOString().slice(0, 10);
}

function buildImportedLoTWQSO(record: any, callsign: string) {
  return {
    ...record,
    id: record.id || `lotw-${record.callsign}-${record.startTime}`,
    myCallsign: record.myCallsign || normalizeCallsign(callsign),
    messages: Array.isArray(record.messages) ? record.messages : [],
  };
}

async function emitLogbookRefresh(logBookId: string, operatorId?: string): Promise<void> {
  try {
    const digitalRadioEngine = DigitalRadioEngine.getInstance();
    const logBook = LogManager.getInstance().getLogBook(logBookId);
    if (!logBook) return;

    const statistics = await logBook.provider.getStatistics();
    digitalRadioEngine.emit('logbookUpdated' as any, {
      logBookId,
      statistics,
      operatorId: operatorId || '',
    });
  } catch (error) {
    logger.warn('Failed to emit logbook refresh after sync', error);
  }
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
          const logManager = LogManager.getInstance();
          const targetLogBook = await getTargetLogBook(callsign, logManager);
          const allQSOs = await targetLogBook.provider.queryQSOs({});
          const pendingQSOs = allQSOs.filter((qso: any) => qso.lotwQslSent !== 'Y');

          if (pendingQSOs.length === 0) {
            result = {
              success: true,
              message: 'No pending QSO records found to upload',
              uploadedCount: 0,
              downloadedCount: 0,
              confirmedCount: 0,
              updatedCount: 0,
              importedCount: 0,
              errorCount: 0,
              syncTime: Date.now(),
            };
          } else {
            logger.debug(`Uploading ${pendingQSOs.length} QSOs to LoTW (${callsign})`);
            result = await service.uploadQSOs(pendingQSOs);
            if (result.success && result.uploadedCount > 0) {
              const markedCount = await markLotwUploadSent(targetLogBook.provider, pendingQSOs);
              const existingConfig = configManager.getCallsignSyncConfig(callsign);
              await configManager.updateCallsignSyncConfig(callsign, {
                lotw: {
                  ...(existingConfig?.lotw || {}),
                  lastUploadTime: Date.now(),
                } as LoTWConfig,
              });
              result.updatedCount = markedCount;
              result.importedCount = 0;
              logger.info(`Marked ${markedCount} QSOs as LoTW sent`);
              await emitLogbookRefresh(targetLogBook.id, targetLogBook.operatorId);
            }
          }
          break;
        }

        case 'download_confirmations': {
          const logManager = LogManager.getInstance();
          const targetLogBook = await getTargetLogBook(callsign, logManager);
          const existingConfig = configManager.getCallsignSyncConfig(callsign);
          const effectiveSince = resolveLotwConfirmationSince(
            syncRequest.since,
            existingConfig?.lotw?.lastDownloadTime
          );
          const { records, confirmedCount } = await service.downloadConfirmations(effectiveSince);
          let updatedCount = 0;
          let importedCount = 0;
          let errorCount = 0;
          const errors: string[] = [];

          for (const record of records) {
            try {
              const match = await findMatchingLocalQSO(targetLogBook.provider, record);
              if (match) {
                const changedUpdates = getChangedLotwWriteBackUpdates(record, match);
                if (Object.keys(changedUpdates).length > 0) {
                  await targetLogBook.provider.updateQSO(match.id, changedUpdates);
                  updatedCount++;
                }
                continue;
              }

              await targetLogBook.provider.addQSO(
                buildImportedLoTWQSO(record, callsign),
                targetLogBook.operatorId
              );
              importedCount++;
            } catch (error) {
              errorCount++;
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              errors.push(`${record.callsign}@${record.startTime}: ${errorMessage}`);
              logger.warn('Failed to process LoTW confirmation record', {
                callsign: record.callsign,
                startTime: record.startTime,
                error,
              });
            }
          }

          await configManager.updateCallsignSyncConfig(callsign, {
            lotw: {
              ...(existingConfig?.lotw || {}),
              lastDownloadTime: Date.now(),
            } as LoTWConfig,
          });

          if (updatedCount > 0 || importedCount > 0) {
            await emitLogbookRefresh(targetLogBook.id, targetLogBook.operatorId);
          }

          logger.info(`LoTW confirmation sync completed: updated=${updatedCount}, imported=${importedCount}, total=${records.length}`);
          result = {
            success: errorCount === 0,
            message: `Downloaded ${confirmedCount} LoTW confirmation records, updated ${updatedCount} local QSOs, imported ${importedCount} missing QSOs`,
            uploadedCount: 0,
            downloadedCount: records.length,
            confirmedCount,
            updatedCount,
            importedCount,
            errorCount,
            errors: errors.length > 0 ? errors : undefined,
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
