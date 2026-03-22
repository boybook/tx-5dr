/**
 * PSKReporter API 路由
 *
 * 提供 PSKReporter 配置管理和状态查询接口
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PSKReporterConfig } from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { getPSKReporterService } from '../services/PSKReporterService.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PSKReporterRoute');

export async function pskreporterRoutes(fastify: FastifyInstance) {
  const configManager = ConfigManager.getInstance();

  /**
   * GET /pskreporter/config
   * 获取 PSKReporter 配置
   */
  fastify.get('/pskreporter/config', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const config = configManager.getPSKReporterConfig();
      return reply.code(200).send({
        success: true,
        data: config,
      });
    } catch (error) {
      logger.error('Failed to get config:', error);
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * PUT /pskreporter/config
   * 更新 PSKReporter 配置
   */
  fastify.put('/pskreporter/config', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const updates = request.body as Partial<PSKReporterConfig>;

      // 验证呼号格式（如果提供）
      if (updates.receiverCallsign && !/^[A-Z0-9]{1,10}(\/[A-Z0-9]{1,4})?$/i.test(updates.receiverCallsign)) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: 'Invalid callsign format',
          userMessage: 'Please enter a valid amateur radio callsign',
        });
      }

      // 验证网格格式（如果提供）
      if (updates.receiverLocator && !/^[A-R]{2}[0-9]{2}([A-X]{2})?$/i.test(updates.receiverLocator)) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: 'Invalid grid format',
          userMessage: 'Please enter a valid 4 or 6 digit grid locator, e.g. PL05 or PL05qb',
        });
      }

      await configManager.updatePSKReporterConfig(updates);

      // 通知服务配置已更新
      const service = getPSKReporterService();
      await service.onConfigChanged();

      fastify.log.info('PSKReporter configuration updated:', updates);

      return reply.code(200).send({
        success: true,
        message: 'Configuration saved successfully',
        data: configManager.getPSKReporterConfig(),
      });
    } catch (error) {
      logger.error('Failed to update config:', error);
      if (error instanceof RadioError) {
        throw error;
      }
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  /**
   * GET /pskreporter/status
   * 获取 PSKReporter 运行状态
   */
  fastify.get('/pskreporter/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const service = getPSKReporterService();
      const status = service.getStatus();

      return reply.code(200).send({
        success: true,
        data: status,
      });
    } catch (error) {
      logger.error('Failed to get status:', error);
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * POST /pskreporter/report
   * 手动触发上报（用于测试）
   */
  fastify.post('/pskreporter/report', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const service = getPSKReporterService();
      const status = service.getStatus();

      if (!status.enabled) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_OPERATION,
          message: 'PSKReporter is not enabled',
          userMessage: 'Please enable PSKReporter in settings first',
        });
      }

      if (!status.configValid) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: 'PSKReporter configuration is invalid',
          userMessage: 'Please ensure a valid callsign and grid locator are configured',
        });
      }

      // 触发上报
      await service.sendPendingSpots();

      return reply.code(200).send({
        success: true,
        message: 'Report request sent',
        data: service.getStatus(),
      });
    } catch (error) {
      logger.error('Manual report failed:', error);
      if (error instanceof RadioError) {
        throw error;
      }
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * POST /pskreporter/reset-stats
   * 重置统计信息
   */
  fastify.post('/pskreporter/reset-stats', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      await configManager.updatePSKReporterStats({
        todayReportCount: 0,
        totalReportCount: 0,
        consecutiveFailures: 0,
        lastError: undefined,
        lastReportTime: undefined,
      });

      return reply.code(200).send({
        success: true,
        message: 'Statistics reset successfully',
      });
    } catch (error) {
      logger.error('Failed to reset stats:', error);
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
}
