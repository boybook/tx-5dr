import { EventEmitter } from 'events';
import { ConfigManager } from '../config/config-manager.js';
import { LogManager } from '../log/LogManager.js';
import { WaveLogService } from './WaveLogService.js';
import type { WaveLogSyncResponse, WaveLogConfig, QSORecord } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('WaveLogSyncScheduler');

/**
 * WaveLog同步服务
 * 负责手动触发的下载同步任务
 */
export class WaveLogSyncScheduler extends EventEmitter {
  private static instance: WaveLogSyncScheduler;
  private isSyncing: boolean = false;
  private lastSyncTime: number = 0;

  private constructor() {
    super();
  }

  static getInstance(): WaveLogSyncScheduler {
    if (!WaveLogSyncScheduler.instance) {
      WaveLogSyncScheduler.instance = new WaveLogSyncScheduler();
    }
    return WaveLogSyncScheduler.instance;
  }

  /**
   * 手动触发同步
   */
  async triggerSync(service: WaveLogService, callsign: string): Promise<WaveLogSyncResponse> {
    if (this.isSyncing) {
      throw new Error('同步正在进行中，请稍后再试');
    }

    return await this.performSync(service, callsign);
  }

  /**
   * 执行同步操作
   */
  private async performSync(waveLogService: WaveLogService, callsign: string): Promise<WaveLogSyncResponse> {
    if (this.isSyncing) {
      throw new Error('同步已在进行中');
    }

    this.isSyncing = true;
    const startTime = Date.now();

    try {
      logger.info('Starting download sync');
      this.emit('syncStarted');

      // 获取配置和服务
      const configManager = ConfigManager.getInstance();
      const logManager = LogManager.getInstance();

      // 计算同步时间范围（从上次同步时间到现在）
      const endDate = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
      let startDate: string | undefined;
      
      if (this.lastSyncTime > 0) {
        // 从上次同步时间开始，留出一些重叠时间防止遗漏
        const lastSyncDate = new Date(this.lastSyncTime - 24 * 60 * 60 * 1000); // 向前1天
        startDate = lastSyncDate.toISOString().slice(0, 10).replace(/-/g, '');
      } else {
        // 首次同步，获取最近30天的数据
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        startDate = thirtyDaysAgo.toISOString().slice(0, 10).replace(/-/g, '');
      }

      logger.debug(`Sync date range: ${startDate} to ${endDate}`);

      // 从WaveLog下载QSO记录
      const remoteQSOs = await waveLogService.downloadQSOs({
        startDate,
        endDate
      });

      let downloadedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;
      const errors: string[] = [];

      // 处理每个下载的QSO
      for (const remoteQSO of remoteQSOs) {
        try {
          const processed = await this.processRemoteQSO(remoteQSO, logManager);
          if (processed) {
            downloadedCount++;
          } else {
            skippedCount++;
          }
        } catch (error) {
          errorCount++;
          const errorMsg = error instanceof Error ? error.message : '未知错误';
          errors.push(`${remoteQSO.callsign}: ${errorMsg}`);
          logger.warn(`Failed to process QSO: ${remoteQSO.callsign} - ${errorMsg}`);
        }
      }

      // 更新最后同步时间（写入按呼号配置）
      this.lastSyncTime = startTime;
      const existingConfig = configManager.getCallsignSyncConfig(callsign);
      await configManager.updateCallsignSyncConfig(callsign, {
        wavelog: { ...(existingConfig?.wavelog || {}), lastSyncTime: this.lastSyncTime } as WaveLogConfig,
      });

      const result: WaveLogSyncResponse = {
        success: errorCount === 0,
        message: `同步完成: 下载${downloadedCount}条, 跳过${skippedCount}条, 失败${errorCount}条`,
        uploadedCount: 0,
        downloadedCount,
        skippedCount,
        errorCount,
        errors: errors.length > 0 ? errors : undefined,
        syncTime: this.lastSyncTime
      };

      logger.info(result.message);
      this.emit('syncCompleted', result);

      return result;

    } catch (error) {
      const result: WaveLogSyncResponse = {
        success: false,
        message: error instanceof Error ? error.message : '同步失败',
        uploadedCount: 0,
        downloadedCount: 0,
        skippedCount: 0,
        errorCount: 1,
        errors: [error instanceof Error ? error.message : '未知错误'],
        syncTime: startTime
      };

      logger.error('Sync error:', error);
      this.emit('syncFailed', result);

      return result;

    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 处理从WaveLog下载的单个QSO记录
   * 检查本地是否已存在，如果不存在则添加
   */
  private async processRemoteQSO(remoteQSO: QSORecord, logManager: LogManager): Promise<boolean> {
    try {
      // 获取所有可用的日志本
      const logBooks = logManager.getLogBooks();
      
      if (logBooks.length === 0) {
        logger.warn('No log books available to store downloaded QSOs');
        return false;
      }

      // 检查所有日志本中是否已存在相同的QSO
      for (const logBook of logBooks) {
        const existingQSOs = await logBook.provider.queryQSOs({
          callsign: remoteQSO.callsign,
          timeRange: {
            start: remoteQSO.startTime,
            end: remoteQSO.endTime || remoteQSO.startTime
          },
          limit: 1
        });

        if (existingQSOs.length > 0) {
          logger.debug(`QSO already exists, skipping: ${remoteQSO.callsign} @ ${remoteQSO.startTime}`);
          return false; // 已存在，跳过
        }
      }

      // 选择第一个日志本作为目标（也可以实现更复杂的逻辑）
      const targetLogBook = logBooks[0];
      
      // 添加到日志本（不需要设置logBookId，addQSO会处理）
      await targetLogBook.provider.addQSO(remoteQSO, '');
      logger.info(`Added new QSO: ${remoteQSO.callsign} @ ${remoteQSO.startTime} -> ${targetLogBook.name}`);
      
      return true;

    } catch (error) {
      logger.error(`Failed to process remote QSO: ${remoteQSO.callsign}`, error);
      throw error;
    }
  }

  /**
   * 获取同步状态
   */
  getStatus() {
    return {
      isSyncing: this.isSyncing,
      lastSyncTime: this.lastSyncTime
    };
  }
}