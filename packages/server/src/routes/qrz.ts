/* eslint-disable @typescript-eslint/no-explicit-any */
// QRZRoutes - API响应处理需要使用any

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  QRZConfig,
  QRZConfigSchema,
  QRZTestConnectionRequest,
  QRZTestConnectionRequestSchema,
  QRZSyncRequest,
  QRZSyncRequestSchema
} from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { QRZService, QRZServiceManager } from '../services/QRZService.js';
import { LogManager } from '../log/LogManager.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';

/**
 * 处理手动上传操作
 * 获取本地QSO记录并上传到QRZ
 */
async function handleManualUpload(qrzService: QRZService) {
  try {
    const logManager = LogManager.getInstance();
    const logBooks = logManager.getLogBooks();

    if (logBooks.length === 0) {
      return {
        success: false,
        message: '没有可用的日志本来上传QSO记录',
        uploadedCount: 0,
        downloadedCount: 0,
        skippedCount: 0,
        errorCount: 1,
        errors: ['没有可用的日志本'],
        syncTime: Date.now(),
      };
    }

    // 获取最近一周的QSO记录进行上传
    const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const allQSOs = [];

    for (const logBook of logBooks) {
      try {
        const qsos = await logBook.provider.queryQSOs({
          timeRange: {
            start: oneWeekAgo,
            end: Date.now(),
          },
          limit: 1000,
        });
        allQSOs.push(...qsos);
      } catch (error) {
        console.warn(`📊 [QRZ] 从日志本 ${logBook.name} 获取QSO记录失败:`, error);
      }
    }

    if (allQSOs.length === 0) {
      return {
        success: true,
        message: '没有找到需要上传的QSO记录',
        uploadedCount: 0,
        downloadedCount: 0,
        skippedCount: 0,
        errorCount: 0,
        syncTime: Date.now(),
      };
    }

    console.log(`📊 [QRZ] 准备上传 ${allQSOs.length} 条QSO记录到QRZ`);

    const result = await qrzService.uploadMultipleQSOs(allQSOs);
    return result;
  } catch (error) {
    console.error('📊 [QRZ] 手动上传失败:', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : '手动上传失败',
      uploadedCount: 0,
      downloadedCount: 0,
      skippedCount: 0,
      errorCount: 1,
      errors: [error instanceof Error ? error.message : '未知错误'],
      syncTime: Date.now(),
    };
  }
}

/**
 * QRZ.com Logbook API 路由
 * 前缀: /api/qrz
 */
export async function qrzRoutes(fastify: FastifyInstance) {
  const configManager = ConfigManager.getInstance();
  const qrzManager = QRZServiceManager.getInstance();

  /**
   * 获取QRZ配置
   * GET /api/qrz/config
   */
  fastify.get('/config', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const config = configManager.getQRZConfig();
      return reply.send(config);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 更新QRZ配置
   * PUT /api/qrz/config
   */
  fastify.put('/config', async (request: FastifyRequest<{ Body: Partial<QRZConfig> }>, reply: FastifyReply) => {
    try {
      const updates = QRZConfigSchema.partial().parse(request.body);
      await configManager.updateQRZConfig(updates);

      const newConfig = configManager.getQRZConfig();
      qrzManager.initializeService(newConfig);

      return reply.send(newConfig);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  /**
   * 重置QRZ配置为默认值
   * POST /api/qrz/config/reset
   */
  fastify.post('/config/reset', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await configManager.resetQRZConfig();
      const config = configManager.getQRZConfig();

      qrzManager.initializeService(config);

      return reply.send(config);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 测试QRZ连接
   * POST /api/qrz/test
   */
  fastify.post('/test', async (request: FastifyRequest<{ Body: QRZTestConnectionRequest }>, reply: FastifyReply) => {
    try {
      const testRequest = QRZTestConnectionRequestSchema.parse(request.body);

      // 创建临时的QRZ服务实例进行测试
      const testConfig: QRZConfig = {
        enabled: true,
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

  /**
   * 执行QRZ同步操作
   * POST /api/qrz/sync
   */
  fastify.post('/sync', async (request: FastifyRequest<{ Body: QRZSyncRequest }>, reply: FastifyReply) => {
    try {
      const syncRequest = QRZSyncRequestSchema.parse(request.body);

      const service = qrzManager.getService();
      if (!service) {
        throw new RadioError({
          code: RadioErrorCode.NOT_INITIALIZED,
          message: 'QRZ服务未初始化',
          userMessage: '请先配置QRZ设置',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['在设置页面配置QRZ API密钥', '确保QRZ服务已启用'],
        });
      }

      let result;

      switch (syncRequest.operation) {
        case 'download': {
          // 从QRZ下载QSO记录
          const qsos = await service.downloadQSOs();
          result = {
            success: true,
            message: `下载完成: ${qsos.length}条QSO记录`,
            uploadedCount: 0,
            downloadedCount: qsos.length,
            skippedCount: 0,
            errorCount: 0,
            syncTime: Date.now(),
          };
          break;
        }
        case 'upload': {
          // 上传本地QSO到QRZ
          result = await handleManualUpload(service);
          break;
        }
        case 'full_sync': {
          // 双向完整同步：先下载后上传
          let downloadedCount = 0;
          const downloadErrors: string[] = [];

          try {
            const qsos = await service.downloadQSOs();
            downloadedCount = qsos.length;
          } catch (error) {
            downloadErrors.push(error instanceof Error ? error.message : '下载失败');
          }

          const uploadResult = await handleManualUpload(service);

          result = {
            success: downloadErrors.length === 0 && uploadResult.success,
            message: `完整同步完成 - 下载: ${downloadedCount}条, 上传: ${uploadResult.message}`,
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
            message: `不支持的同步操作类型: ${syncRequest.operation}`,
            userMessage: '不支持的同步操作类型',
            severity: RadioErrorSeverity.WARNING,
            suggestions: ['支持的操作类型：download（下载）、upload（上传）、full_sync（完整同步）'],
          });
      }

      return reply.send(result);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 获取QRZ同步状态
   * GET /api/qrz/status
   */
  fastify.get('/status', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const config = configManager.getQRZConfig();
      const isServiceAvailable = qrzManager.isServiceAvailable();

      return reply.send({
        enabled: config.enabled,
        configured: !!config.apiKey,
        serviceAvailable: isServiceAvailable,
        lastSyncTime: config.lastSyncTime,
        autoUpload: config.autoUploadQSO,
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
}
