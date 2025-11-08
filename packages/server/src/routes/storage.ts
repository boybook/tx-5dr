import { FastifyInstance } from 'fastify';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';

/**
 * 存储管理路由
 * 📊 Day14优化：统一错误处理，使用 RadioError + Fastify 全局错误处理器
 */
export async function storageRoutes(fastify: FastifyInstance) {
  const engine = DigitalRadioEngine.getInstance();

  // 获取持久化存储状态
  fastify.get('/storage/status', async (request, reply) => {
    try {
      const slotPackManager = engine.getSlotPackManager();
      const stats = await slotPackManager.getPersistenceStats();
      const isEnabled = slotPackManager.isPersistenceEnabled();

      return {
        success: true,
        data: {
          enabled: isEnabled,
          ...stats
        },
        timestamp: Date.now()
      };
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 启用/禁用持久化存储
  fastify.post('/storage/toggle', async (request, reply) => {
    try {
      const { enabled } = request.body as { enabled: boolean };

      // 📊 Day14：参数验证使用 RadioError
      if (typeof enabled !== 'boolean') {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: '参数错误：enabled 必须是布尔值',
          userMessage: '请提供有效的开关状态',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['enabled 参数应为 true 或 false'],
        });
      }

      const slotPackManager = engine.getSlotPackManager();
      slotPackManager.setPersistenceEnabled(enabled);

      return {
        success: true,
        data: {
          enabled: slotPackManager.isPersistenceEnabled()
        },
        timestamp: Date.now()
      };
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 强制刷新缓冲区
  fastify.post('/storage/flush', async (request, reply) => {
    try {
      await engine.getSlotPackManager().flushPersistence();

      return {
        success: true,
        data: {
          message: '缓冲区刷新完成'
        },
        timestamp: Date.now()
      };
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 获取可用的存储日期
  fastify.get('/storage/dates', async (request, reply) => {
    try {
      const dates = await engine.getSlotPackManager().getAvailableStorageDates();

      return {
        success: true,
        data: {
          dates: dates,
          count: dates.length
        },
        timestamp: Date.now()
      };
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 读取指定日期的记录
  fastify.get('/storage/records/:date', async (request, reply) => {
    try {
      const { date } = request.params as { date: string };

      // 📊 Day14：验证日期格式使用 RadioError
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: `日期格式错误: ${date}`,
          userMessage: '日期格式不正确',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['日期格式应为 YYYY-MM-DD（例如：2025-11-02）'],
        });
      }

      const records = await engine.getSlotPackManager().readStoredRecords(date);

      // 统计信息
      const totalSlots = records.length;
      const totalFrames = records.reduce((sum, record) => sum + record.slotPack.frames.length, 0);
      const operations = records.reduce((acc, record) => {
        acc[record.operation] = (acc[record.operation] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      return {
        success: true,
        data: {
          date,
          records,
          stats: {
            totalSlots,
            totalFrames,
            operations,
            fileSize: records.length > 0 ? 'N/A' : '0B' // 实际文件大小需要读取文件系统
          }
        },
        timestamp: Date.now()
      };
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 获取存储统计摘要
  fastify.get('/storage/summary', async (request, reply) => {
    try {
      const slotPackManager = engine.getSlotPackManager();
      const dates = await slotPackManager.getAvailableStorageDates();
      const stats = await slotPackManager.getPersistenceStats();

      // 计算总体统计
      let totalRecords = 0;
      let totalFrames = 0;
      const recentDates = dates.slice(-7); // 最近7天

      for (const date of recentDates) {
        try {
          const records = await slotPackManager.readStoredRecords(date);
          totalRecords += records.length;
          totalFrames += records.reduce((sum, record) => sum + record.slotPack.frames.length, 0);
        } catch (error) {
          console.warn(`读取日期 ${date} 的记录失败:`, error);
        }
      }

      return {
        success: true,
        data: {
          totalDates: dates.length,
          recentDays: recentDates.length,
          totalRecordsRecent: totalRecords,
          totalFramesRecent: totalFrames,
          averageFramesPerSlot: totalRecords > 0 ? Math.round(totalFrames / totalRecords) : 0,
          enabled: slotPackManager.isPersistenceEnabled(),
          currentStatus: stats
        },
        timestamp: Date.now()
      };
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
} 