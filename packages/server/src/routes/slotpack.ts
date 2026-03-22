/* eslint-disable @typescript-eslint/no-explicit-any */
// SlotPackRoutes - FastifyRequest处理需要使用any

import type { FastifyInstance } from 'fastify';
import type { SlotPack } from '@tx5dr/contracts';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';

/**
 * 时隙包管理 API 路由
 * 📊 Day14优化：统一错误处理，使用 RadioError + Fastify 全局错误处理器
 */
export async function slotpackRoutes(fastify: FastifyInstance) {
  const clockManager = DigitalRadioEngine.getInstance();
  
  // 获取所有活跃的时隙包
  fastify.get('/slotpacks', async (request, reply) => {
    try {
      const slotPacks: SlotPack[] = clockManager.getActiveSlotPacks();
      
      return {
        success: true,
        data: slotPacks,
        timestamp: Date.now()
      };
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
  
  // 获取指定时隙包
  fastify.get('/slotpacks/:slotId', async (request, reply) => {
    try {
      const { slotId } = request.params as { slotId: string };
      
      const slotPack = clockManager.getSlotPack(slotId);

      if (!slotPack) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `SlotPack ${slotId} not found`,
          userMessage: 'Specified SlotPack not found',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['Check if slot ID is correct', 'View list of active SlotPacks'],
        });
      }

      return {
        success: true,
        data: slotPack,
        timestamp: Date.now()
      };
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 获取时隙包统计信息
  fastify.get('/slotpacks/stats', async (request, reply) => {
    try {
      const activeSlotPacks = clockManager.getActiveSlotPacks();
      const totalFrames = activeSlotPacks.reduce((sum: number, pack: SlotPack) => sum + pack.frames.length, 0);
      const totalDecodes = activeSlotPacks.reduce((sum: number, pack: SlotPack) => sum + pack.stats.totalDecodes, 0);
      
      const stats = {
        activeSlotPacks: activeSlotPacks.length,
        totalProcessed: totalDecodes,
        totalFrames: totalFrames,
        averageFramesPerSlot: activeSlotPacks.length > 0 ? totalFrames / activeSlotPacks.length : 0,
        lastActivity: activeSlotPacks.length > 0 ? Math.max(...activeSlotPacks.map((p: SlotPack) => p.stats.lastUpdated)) : Date.now()
      };
      
      return {
        success: true,
        data: stats,
        timestamp: Date.now()
      };
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
} 