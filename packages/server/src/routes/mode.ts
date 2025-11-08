import { FastifyInstance } from 'fastify';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ModeDescriptorSchema } from '@tx5dr/contracts';
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
  }, async (request, reply) => {
    try {
      const newMode = ModeDescriptorSchema.parse(request.body);
      
      // 检查引擎是否正在运行
      const wasRunning = digitalRadioEngine.getStatus().isRunning;
      
      // 如果引擎正在运行，先停止它
      if (wasRunning) {
        fastify.log.info('模式切换：停止解码引擎以应用新模式');
        await digitalRadioEngine.stop();
      }
      
      // 切换模式
      await digitalRadioEngine.setMode(newMode);
      fastify.log.info(`模式已切换到: ${newMode.name}`);
      
      // 如果引擎之前在运行，重新启动它
      if (wasRunning) {
        fastify.log.info('模式切换：重新启动解码引擎');
        await digitalRadioEngine.start();
      }

      const status = digitalRadioEngine.getStatus();
      
      return reply.code(200).send({
        success: true,
        message: wasRunning 
          ? '模式切换成功，解码引擎已重新启动' 
          : '模式切换成功',
        data: status.currentMode,
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      // Zod验证错误会被Fastify自动捕获，这里只处理操作失败
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
} 