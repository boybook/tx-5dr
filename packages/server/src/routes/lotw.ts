/* eslint-disable @typescript-eslint/no-explicit-any */
// LoTWRoutes - API响应处理需要使用any

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  LoTWConfig,
  LoTWConfigSchema,
  LoTWTestConnectionRequest,
  LoTWTestConnectionRequestSchema,
  LoTWTQSLDetectRequest,
  LoTWTQSLDetectRequestSchema,
  LoTWSyncRequest,
  LoTWSyncRequestSchema,
} from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { LoTWService, LoTWServiceManager } from '../services/LoTWService.js';
import { LogManager } from '../log/LogManager.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';

/**
 * LoTW API路由
 * 提供LoTW配置管理、TQSL检测、连接测试和QSO同步功能
 */
export async function lotwRoutes(fastify: FastifyInstance) {
  const configManager = ConfigManager.getInstance();
  const lotwManager = LoTWServiceManager.getInstance();

  /**
   * 获取LoTW配置
   * GET /api/lotw/config
   */
  fastify.get('/config', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const config = configManager.getLoTWConfig();
      return reply.send(config);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 更新LoTW配置
   * PUT /api/lotw/config
   */
  fastify.put('/config', async (request: FastifyRequest<{ Body: Partial<LoTWConfig> }>, reply: FastifyReply) => {
    try {
      const updates = LoTWConfigSchema.partial().parse(request.body);
      await configManager.updateLoTWConfig(updates);

      // 更新LoTW服务实例
      const newConfig = configManager.getLoTWConfig();
      lotwManager.initializeService(newConfig);

      return reply.send(newConfig);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  /**
   * 重置LoTW配置为默认值
   * POST /api/lotw/config/reset
   */
  fastify.post('/config/reset', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await configManager.resetLoTWConfig();
      const config = configManager.getLoTWConfig();

      // 重新初始化LoTW服务
      lotwManager.initializeService(config);

      return reply.send(config);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 测试LoTW连接
   * POST /api/lotw/test
   */
  fastify.post('/test', async (request: FastifyRequest<{ Body: LoTWTestConnectionRequest }>, reply: FastifyReply) => {
    try {
      const testRequest = LoTWTestConnectionRequestSchema.parse(request.body);

      // 创建临时的LoTW服务实例进行测试
      const testConfig: LoTWConfig = {
        enabled: true,
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

  /**
   * 检测TQSL安装
   * POST /api/lotw/detect-tqsl
   */
  fastify.post('/detect-tqsl', async (request: FastifyRequest<{ Body: LoTWTQSLDetectRequest }>, reply: FastifyReply) => {
    try {
      const detectRequest = LoTWTQSLDetectRequestSchema.parse(request.body);

      // 使用现有服务或创建临时实例
      const service = lotwManager.getService() || new LoTWService(configManager.getLoTWConfig());
      const result = await service.detectTQSL(detectRequest.tqslPath);

      // 如果检测到TQSL，自动保存路径到配置
      if (result.found && result.path) {
        await configManager.updateLoTWConfig({ tqslPath: result.path });
        lotwManager.initializeService(configManager.getLoTWConfig());
      }

      return reply.send(result);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 执行LoTW同步操作
   * POST /api/lotw/sync
   */
  fastify.post('/sync', async (request: FastifyRequest<{ Body: LoTWSyncRequest }>, reply: FastifyReply) => {
    try {
      const syncRequest = LoTWSyncRequestSchema.parse(request.body);

      const service = lotwManager.getService();
      if (!service) {
        throw new RadioError({
          code: RadioErrorCode.NOT_INITIALIZED,
          message: 'LoTW服务未初始化',
          userMessage: '请先配置LoTW设置',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['在设置页面配置LoTW用户名和密码', '确保LoTW服务已启用'],
        });
      }

      let result;

      switch (syncRequest.operation) {
        case 'upload': {
          // 获取本地最近一周QSO并上传
          const logManager = LogManager.getInstance();
          const logBooks = logManager.getLogBooks();

          if (logBooks.length === 0) {
            result = {
              success: false,
              message: '没有可用的日志本来上传QSO记录',
              uploadedCount: 0,
              downloadedCount: 0,
              confirmedCount: 0,
              errorCount: 1,
              errors: ['没有可用的日志本'],
              syncTime: Date.now(),
            };
            break;
          }

          const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
          const allQSOs: any[] = [];

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
              console.warn(`[LoTW] 从日志本 ${logBook.name} 获取QSO记录失败:`, error);
            }
          }

          if (allQSOs.length === 0) {
            result = {
              success: true,
              message: '没有找到需要上传的QSO记录',
              uploadedCount: 0,
              downloadedCount: 0,
              confirmedCount: 0,
              errorCount: 0,
              syncTime: Date.now(),
            };
          } else {
            console.log(`[LoTW] 准备上传 ${allQSOs.length} 条QSO记录到LoTW`);
            result = await service.uploadQSOs(allQSOs);
          }
          break;
        }

        case 'download_confirmations': {
          const { records, confirmedCount } = await service.downloadConfirmations(syncRequest.since);
          result = {
            success: true,
            message: `下载了 ${confirmedCount} 条LoTW确认记录`,
            uploadedCount: 0,
            downloadedCount: records.length,
            confirmedCount,
            errorCount: 0,
            syncTime: Date.now(),
          };
          break;
        }

        default:
          throw new RadioError({
            code: RadioErrorCode.INVALID_OPERATION,
            message: `不支持的同步操作类型: ${(syncRequest as any).operation}`,
            userMessage: '不支持的同步操作类型',
            severity: RadioErrorSeverity.WARNING,
            suggestions: ['支持的操作类型：upload（上传）、download_confirmations（下载确认）'],
          });
      }

      return reply.send(result);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 获取LoTW同步状态
   * GET /api/lotw/status
   */
  fastify.get('/status', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const config = configManager.getLoTWConfig();
      const isServiceAvailable = lotwManager.isServiceAvailable();

      return reply.send({
        enabled: config.enabled,
        configured: !!(config.username && config.password),
        tqslConfigured: !!config.tqslPath,
        serviceAvailable: isServiceAvailable,
        lastUploadTime: config.lastUploadTime,
        lastDownloadTime: config.lastDownloadTime,
        autoUpload: config.autoUploadQSO,
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
}
