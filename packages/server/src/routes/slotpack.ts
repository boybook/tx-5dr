import type { FastifyInstance } from 'fastify';
import type { SlotPack } from '@tx5dr/contracts';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';

/**
 * 时隙包管理 API 路由
 */
export async function slotpackRoutes(fastify: FastifyInstance) {
  const clockManager = DigitalRadioEngine.getInstance();
  
  // 获取所有活跃的时隙包
  fastify.get('/api/slotpacks', async (request, reply) => {
    try {
      const slotPacks: SlotPack[] = clockManager.getActiveSlotPacks();
      
      return {
        success: true,
        data: slotPacks,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('获取时隙包失败:', error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      });
    }
  });
  
  // 获取指定时隙包
  fastify.get('/api/slotpacks/:slotId', async (request, reply) => {
    try {
      const { slotId } = request.params as { slotId: string };
      
      const slotPack = clockManager.getSlotPack(slotId);
      
      if (!slotPack) {
        return reply.status(404).send({
          success: false,
          error: '时隙包未找到'
        });
      }
      
      return {
        success: true,
        data: slotPack,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('获取时隙包失败:', error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      });
    }
  });
  
  // 获取时隙包统计信息
  fastify.get('/api/slotpacks/stats', async (request, reply) => {
    try {
      const activeSlotPacks = clockManager.getActiveSlotPacks();
      const totalFrames = activeSlotPacks.reduce((sum, pack) => sum + pack.frames.length, 0);
      const totalDecodes = activeSlotPacks.reduce((sum, pack) => sum + pack.stats.totalDecodes, 0);
      
      const stats = {
        activeSlotPacks: activeSlotPacks.length,
        totalProcessed: totalDecodes,
        totalFrames: totalFrames,
        averageFramesPerSlot: activeSlotPacks.length > 0 ? totalFrames / activeSlotPacks.length : 0,
        lastActivity: activeSlotPacks.length > 0 ? Math.max(...activeSlotPacks.map(p => p.stats.lastUpdated)) : Date.now()
      };
      
      return {
        success: true,
        data: stats,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('获取时隙包统计失败:', error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      });
    }
  });
} 