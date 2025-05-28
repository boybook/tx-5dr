import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { MODES, type ModeDescriptor } from '@tx5dr/contracts';

export async function clockRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  const clockManager = DigitalRadioEngine.getInstance();

  // 获取可用模式列表
  fastify.get('/modes', async (request, reply) => {
    try {
      const modes = clockManager.getAvailableModes();
      return {
        modes,
        default: 'FT8'
      };
    } catch (error) {
      fastify.log.error('获取模式列表失败:', error);
      reply.status(500);
      return { error: '获取模式列表失败' };
    }
  });

  // 获取时钟状态
  fastify.get('/status', async (request, reply) => {
    try {
      const status = clockManager.getStatus();
      return status;
    } catch (error) {
      fastify.log.error('获取时钟状态失败:', error);
      reply.status(500);
      return { error: '获取时钟状态失败' };
    }
  });

  // 设置时钟模式
  fastify.post<{
    Body: { mode: string }
  }>('/mode', async (request, reply) => {
    try {
      const { mode } = request.body;
      
      // 验证模式名称
      const availableModes = clockManager.getAvailableModes();
      const targetMode = availableModes.find(m => m.name === mode);
      
      if (!targetMode) {
        reply.status(400);
        return { 
          error: '无效的模式名称',
          availableModes: availableModes.map(m => m.name)
        };
      }
      
      clockManager.setMode(targetMode);
      
      return { 
        success: true,
        message: `时钟模式已切换到 ${mode}`,
        currentMode: targetMode
      };
    } catch (error) {
      fastify.log.error('设置时钟模式失败:', error);
      reply.status(500);
      return { error: '设置时钟模式失败' };
    }
  });

  // 控制时钟启停
  fastify.post<{
    Body: { action: 'start' | 'stop' }
  }>('/control', async (request, reply) => {
    try {
      const { action } = request.body;
      
      if (action === 'start') {
        clockManager.start();
        return { 
          success: true,
          message: '时钟已启动',
          status: clockManager.getStatus()
        };
      } else if (action === 'stop') {
        clockManager.stop();
        return { 
          success: true,
          message: '时钟已停止',
          status: clockManager.getStatus()
        };
      } else {
        reply.status(400);
        return { 
          error: '无效的操作',
          validActions: ['start', 'stop']
        };
      }
    } catch (error) {
      fastify.log.error('控制时钟失败:', error);
      reply.status(500);
      return { error: '控制时钟失败' };
    }
  });
} 