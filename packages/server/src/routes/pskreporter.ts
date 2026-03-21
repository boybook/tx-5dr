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
          message: '呼号格式无效',
          userMessage: '请输入有效的业余电台呼号',
        });
      }

      // 验证网格格式（如果提供）
      if (updates.receiverLocator && !/^[A-R]{2}[0-9]{2}([A-X]{2})?$/i.test(updates.receiverLocator)) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: '网格格式无效',
          userMessage: '请输入有效的4位或6位网格坐标，如 PL05 或 PL05qb',
        });
      }

      await configManager.updatePSKReporterConfig(updates);

      // 通知服务配置已更新
      const service = getPSKReporterService();
      await service.onConfigChanged();

      fastify.log.info('PSKReporter配置已更新:', updates);

      return reply.code(200).send({
        success: true,
        message: '配置保存成功',
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
          message: 'PSKReporter 未启用',
          userMessage: '请先在设置中启用 PSKReporter',
        });
      }

      if (!status.configValid) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: 'PSKReporter 配置无效',
          userMessage: '请确保已配置有效的呼号和网格坐标',
        });
      }

      // 触发上报
      await service.sendPendingSpots();

      return reply.code(200).send({
        success: true,
        message: '上报请求已发送',
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
        message: '统计信息已重置',
      });
    } catch (error) {
      logger.error('Failed to reset stats:', error);
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
}
