import { FastifyInstance } from 'fastify';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ModeDescriptorSchema } from '@tx5dr/contracts';
import { requireAbility } from '../auth/authPlugin.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';

/**
 * 模式管理API路由
 * 📊 Day14优化：统一错误处理，使用 RadioError + Fastify 全局错误处理器
 */
export async function modeRoutes(fastify: FastifyInstance) {
  const digitalRadioEngine = DigitalRadioEngine.getInstance();

  // 获取所有可用模式
  fastify.get('/', async (request, reply) => {
    try {
      const modes = digitalRadioEngine.getAvailableModes();
      return reply.code(200).send({
        success: true,
        data: modes,
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 获取当前模式
  fastify.get('/current', async (request, reply) => {
    try {
      const status = digitalRadioEngine.getStatus();
      return reply.code(200).send({
        success: true,
        data: status.currentMode,
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 切换模式
  fastify.post('/switch', {
    schema: {
      body: zodToJsonSchema(ModeDescriptorSchema),
    },
    preHandler: [requireAbility('execute', 'ModeSwitch')],
  }, async (request, reply) => {
    try {
      const newMode = ModeDescriptorSchema.parse(request.body);

      await digitalRadioEngine.setMode(newMode);
      fastify.log.info(`Mode switched to: ${newMode.name}`);

      const status = digitalRadioEngine.getStatus();

      return reply.code(200).send({
        success: true,
        message: 'Mode switched successfully',
        data: status.currentMode,
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      // Zod验证错误会被Fastify自动捕获，这里只处理操作失败
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
} 
