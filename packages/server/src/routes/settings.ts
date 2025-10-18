import { FastifyInstance } from 'fastify';
import { ConfigManager } from '../config/config-manager.js';

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
      fastify.log.error('获取FT8配置失败:', error);
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : '获取配置失败',
      });
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
      fastify.log.error('保存FT8配置失败:', error);
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : '保存配置失败',
      });
    }
  });
}
