import { FastifyInstance } from 'fastify';
import { ConfigManager } from '../config/config-manager.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';

/**
 * 设置管理API路由
 * 📊 Day14优化：统一错误处理，使用 RadioError + Fastify 全局错误处理器
 */
export async function settingsRoutes(fastify: FastifyInstance) {
  const configManager = ConfigManager.getInstance();

  // 获取 FT8 配置
  fastify.get('/ft8', async (request, reply) => {
    try {
      const ft8Config = configManager.getFT8Config();
      return reply.code(200).send({
        success: true,
        data: ft8Config,
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 更新 FT8 配置
  fastify.put('/ft8', async (request, reply) => {
    try {
      const updates = request.body as Partial<{
        myCallsign: string;
        myGrid: string;
        frequency: number;
        transmitPower: number;
        autoReply: boolean;
        maxQSOTimeout: number;
        decodeWhileTransmitting: boolean;
        spectrumWhileTransmitting: boolean;
      }>;

      await configManager.updateFT8Config(updates);
      fastify.log.info('FT8配置已更新:', updates);

      return reply.code(200).send({
        success: true,
        message: '配置保存成功',
        data: configManager.getFT8Config(),
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });
}
