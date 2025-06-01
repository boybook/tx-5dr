import { FastifyInstance } from 'fastify';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ModeDescriptorSchema } from '@tx5dr/contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';

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
      fastify.log.error('获取可用模式失败:', error);
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : '未知错误',
      });
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
      fastify.log.error('获取当前模式失败:', error);
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : '未知错误',
      });
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
      fastify.log.error('切换模式失败:', error);
      
      if (error instanceof Error && error.name === 'ZodError') {
        return reply.code(400).send({
          success: false,
          message: '请求参数格式错误',
        });
      }
      
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : '未知错误',
      });
    }
  });
} 