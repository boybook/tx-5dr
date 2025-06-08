import { FastifyInstance } from 'fastify';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';

/**
 * 存储管理路由
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
      console.error('获取存储状态失败:', error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      });
    }
  });

  // 启用/禁用持久化存储
  fastify.post('/storage/toggle', async (request, reply) => {
    try {
      const { enabled } = request.body as { enabled: boolean };
      
      if (typeof enabled !== 'boolean') {
        return reply.status(400).send({
          success: false,
          error: '参数错误：enabled 必须是布尔值'
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
      console.error('切换存储状态失败:', error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      });
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
      console.error('刷新缓冲区失败:', error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      });
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
      console.error('获取存储日期失败:', error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      });
    }
  });

  // 读取指定日期的记录
  fastify.get('/storage/records/:date', async (request, reply) => {
    try {
      const { date } = request.params as { date: string };
      
      // 验证日期格式
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return reply.status(400).send({
          success: false,
          error: '日期格式错误，应为 YYYY-MM-DD'
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
      console.error('读取存储记录失败:', error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      });
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
      console.error('获取存储摘要失败:', error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      });
    }
  });
} 