import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { 
  WaveLogConfig,
  WaveLogConfigSchema,
  WaveLogTestConnectionRequest,
  WaveLogTestConnectionRequestSchema,
  WaveLogTestConnectionResponse,
  WaveLogQSOUploadRequest,
  WaveLogQSOUploadRequestSchema,
  WaveLogSyncRequest,
  WaveLogSyncRequestSchema
} from '@tx5dr/contracts';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ConfigManager } from '../config/config-manager.js';
import { WaveLogService, WaveLogServiceManager } from '../services/WaveLogService.js';
import { LogManager } from '../log/LogManager.js';

/**
 * 处理手动上传操作
 * 获取本地QSO记录并上传到WaveLog
 */
async function handleManualUpload(waveLogService: WaveLogService) {
  try {
    const logManager = LogManager.getInstance();
    const logBooks = logManager.getLogBooks();
    
    if (logBooks.length === 0) {
      return {
        success: false,
        message: '没有可用的日志本来上传QSO记录',
        uploadedCount: 0,
        downloadedCount: 0,
        skippedCount: 0,
        errorCount: 1,
        errors: ['没有可用的日志本'],
        syncTime: Date.now()
      };
    }
    
    // 获取最近一周的QSO记录进行上传
    const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let allQSOs = [];
    
    for (const logBook of logBooks) {
      try {
        const qsos = await logBook.provider.queryQSOs({
          timeRange: {
            start: oneWeekAgo,
            end: Date.now()
          },
          limit: 1000 // 限制数量避免一次上传太多
        });
        allQSOs.push(...qsos);
      } catch (error) {
        console.warn(`📊 [WaveLog] 从日志本 ${logBook.name} 获取QSO记录失败:`, error);
      }
    }
    
    if (allQSOs.length === 0) {
      return {
        success: true,
        message: '没有找到需要上传的QSO记录',
        uploadedCount: 0,
        downloadedCount: 0,
        skippedCount: 0,
        errorCount: 0,
        syncTime: Date.now()
      };
    }
    
    console.log(`📊 [WaveLog] 准备上传 ${allQSOs.length} 条QSO记录到WaveLog`);
    
    // 批量上传QSO记录
    const result = await waveLogService.uploadMultipleQSOs(allQSOs);
    
    return result;
    
  } catch (error) {
    console.error('📊 [WaveLog] 手动上传失败:', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : '手动上传失败',
      uploadedCount: 0,
      downloadedCount: 0,
      skippedCount: 0,
      errorCount: 1,
      errors: [error instanceof Error ? error.message : '未知错误'],
      syncTime: Date.now()
    };
  }
}

/**
 * WaveLog同步API路由
 */
export async function waveLogRoutes(fastify: FastifyInstance) {
  const configManager = ConfigManager.getInstance();
  const waveLogManager = WaveLogServiceManager.getInstance();

  /**
   * 获取WaveLog配置
   * GET /api/wavelog/config
   */
  fastify.get('/config', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const config = configManager.getWaveLogConfig();
      return reply.send(config);
    } catch (error) {
      fastify.log.error('获取WaveLog配置失败:', error);
      return reply.status(500).send({
        success: false,
        message: error instanceof Error ? error.message : '获取配置失败'
      });
    }
  });

  /**
   * 更新WaveLog配置
   * PUT /api/wavelog/config
   */
  fastify.put('/config', async (request: FastifyRequest<{ Body: Partial<WaveLogConfig> }>, reply: FastifyReply) => {
    try {
      const updates = WaveLogConfigSchema.partial().parse(request.body);
      await configManager.updateWaveLogConfig(updates);
      
      // 更新WaveLog服务实例
      const newConfig = configManager.getWaveLogConfig();
      waveLogManager.initializeService(newConfig);
      
      return reply.send(newConfig);
    } catch (error) {
      fastify.log.error('更新WaveLog配置失败:', error);
      return reply.status(400).send({
        success: false,
        message: error instanceof Error ? error.message : '更新配置失败'
      });
    }
  });

  /**
   * 测试WaveLog连接
   * POST /api/wavelog/test
   */
  fastify.post('/test', async (request: FastifyRequest<{ Body: WaveLogTestConnectionRequest }>, reply: FastifyReply) => {
    try {
      const testRequest = WaveLogTestConnectionRequestSchema.parse(request.body);
      
      // 创建临时的WaveLog服务实例进行测试
      const testConfig: WaveLogConfig = {
        enabled: true,
        url: testRequest.url,
        apiKey: testRequest.apiKey,
        stationId: '', // 测试时还不知道stationId
        radioName: 'TX5DR',
        autoUploadQSO: true
      };
      
      const testService = new WaveLogService(testConfig);
      const result = await testService.testConnection();
      
      return reply.send(result);
    } catch (error) {
      fastify.log.error('测试WaveLog连接失败:', error);
      const response: WaveLogTestConnectionResponse = {
        success: false,
        message: error instanceof Error ? error.message : '测试连接失败'
      };
      return reply.send(response);
    }
  });

  /**
   * 重置WaveLog配置为默认值
   * POST /api/wavelog/config/reset
   */
  fastify.post('/config/reset', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await configManager.resetWaveLogConfig();
      const config = configManager.getWaveLogConfig();
      
      // 重新初始化WaveLog服务
      waveLogManager.initializeService(config);
      
      return reply.send(config);
    } catch (error) {
      fastify.log.error('重置WaveLog配置失败:', error);
      return reply.status(500).send({
        success: false,
        message: error instanceof Error ? error.message : '重置配置失败'
      });
    }
  });

  /**
   * 手动上传QSO记录到WaveLog
   * POST /api/wavelog/upload
   */
  fastify.post('/upload', async (request: FastifyRequest<{ Body: WaveLogQSOUploadRequest }>, reply: FastifyReply) => {
    try {
      const uploadRequest = WaveLogQSOUploadRequestSchema.parse(request.body);
      
      const service = waveLogManager.getService();
      if (!service) {
        return reply.status(400).send({
          success: false,
          message: 'WaveLog服务未初始化，请先配置WaveLog设置'
        });
      }

      // 获取要上传的QSO记录
      // 这需要从LogManager获取具体的QSO记录
      // TODO: 实现从LogManager获取QSO记录的逻辑
      
      return reply.status(501).send({
        success: false,
        message: '手动上传功能待实现'
      });
    } catch (error) {
      fastify.log.error('上传QSO到WaveLog失败:', error);
      return reply.status(500).send({
        success: false,
        message: error instanceof Error ? error.message : '上传失败'
      });
    }
  });

  /**
   * 执行WaveLog同步操作
   * POST /api/wavelog/sync
   */
  fastify.post('/sync', async (request: FastifyRequest<{ Body: WaveLogSyncRequest }>, reply: FastifyReply) => {
    try {
      const syncRequest = WaveLogSyncRequestSchema.parse(request.body);
      
      const service = waveLogManager.getService();
      if (!service) {
        return reply.status(400).send({
          success: false,
          message: 'WaveLog服务未初始化，请先配置WaveLog设置'
        });
      }

      // 导入同步调度器
      const { WaveLogSyncScheduler } = await import('../services/WaveLogSyncScheduler.js');
      const syncScheduler = WaveLogSyncScheduler.getInstance();

      let result;

      switch (syncRequest.operation) {
        case 'download':
          // 手动触发下载同步
          result = await syncScheduler.triggerSync();
          break;
        case 'upload':
          // 手动上传功能：上传本地新增的QSO到WaveLog
          result = await handleManualUpload(service);
          break;
        case 'full_sync':
          // 双向完整同步：先下载后上传
          const downloadResult = await syncScheduler.triggerSync();
          const uploadResult = await handleManualUpload(service);
          
          result = {
            success: downloadResult.success && uploadResult.success,
            message: `完整同步完成 - 下载: ${downloadResult.message}, 上传: ${uploadResult.message}`,
            uploadedCount: uploadResult.uploadedCount,
            downloadedCount: downloadResult.downloadedCount,
            skippedCount: downloadResult.skippedCount + uploadResult.skippedCount,
            errorCount: downloadResult.errorCount + uploadResult.errorCount,
            errors: [...(downloadResult.errors || []), ...(uploadResult.errors || [])],
            syncTime: Date.now()
          };
          break;
        default:
          return reply.status(400).send({
            success: false,
            message: '不支持的同步操作类型'
          });
      }

      return reply.send(result);
    } catch (error) {
      fastify.log.error('WaveLog同步操作失败:', error);
      return reply.status(500).send({
        success: false,
        message: error instanceof Error ? error.message : '同步操作失败'
      });
    }
  });

  /**
   * 诊断WaveLog连接问题
   * POST /api/wavelog/diagnose
   */
  fastify.post('/diagnose', async (request: FastifyRequest<{ Body: WaveLogTestConnectionRequest }>, reply: FastifyReply) => {
    try {
      const testRequest = WaveLogTestConnectionRequestSchema.parse(request.body);
      
      // 创建临时的WaveLog服务实例进行诊断
      const testConfig: WaveLogConfig = {
        enabled: true,
        url: testRequest.url,
        apiKey: testRequest.apiKey,
        stationId: '', 
        radioName: 'TX5DR',
        autoUploadQSO: true
      };
      
      const testService = new WaveLogService(testConfig);
      
      // 执行网络连接诊断
      const diagnosis = await testService.diagnoseConnection();
      
      let additionalInfo = '';
      if (!diagnosis.reachable) {
        if (diagnosis.error?.includes('ENOTFOUND')) {
          additionalInfo = '建议检查: 1) URL拼写是否正确 2) 域名是否存在 3) 网络连接';
        } else if (diagnosis.error?.includes('ECONNREFUSED')) {
          additionalInfo = '建议检查: 1) WaveLog服务是否运行 2) 端口号是否正确 3) 防火墙设置';
        } else if (diagnosis.error?.includes('timeout')) {
          additionalInfo = '建议检查: 1) 网络延迟 2) WaveLog服务器负载 3) 防火墙超时设置';
        } else {
          additionalInfo = '建议检查: 1) 网络连接 2) WaveLog服务器状态 3) URL配置';
        }
      }
      
      return reply.send({
        success: diagnosis.reachable,
        message: diagnosis.reachable ? 
          `连接诊断成功 - 响应时间: ${diagnosis.responseTime}ms, HTTP状态: ${diagnosis.httpStatus}` :
          `连接诊断失败 - ${diagnosis.error}`,
        diagnosis: {
          ...diagnosis,
          additionalInfo
        }
      });
    } catch (error) {
      fastify.log.error('WaveLog连接诊断失败:', error);
      return reply.send({
        success: false,
        message: error instanceof Error ? error.message : '诊断失败'
      });
    }
  });

  /**
   * 获取WaveLog同步状态
   * GET /api/wavelog/status
   */
  fastify.get('/status', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const config = configManager.getWaveLogConfig();
      const isServiceAvailable = waveLogManager.isServiceAvailable();
      
      // 获取同步调度器状态
      let schedulerStatus = null;
      try {
        const { WaveLogSyncScheduler } = await import('../services/WaveLogSyncScheduler.js');
        const syncScheduler = WaveLogSyncScheduler.getInstance();
        schedulerStatus = syncScheduler.getStatus();
      } catch (error) {
        fastify.log.warn('获取同步调度器状态失败:', error);
      }
      
      return reply.send({
        enabled: config.enabled,
        configured: !!(config.url && config.apiKey && config.stationId),
        serviceAvailable: isServiceAvailable,
        lastSyncTime: config.lastSyncTime,
        autoUpload: config.autoUploadQSO,
        scheduler: schedulerStatus
      });
    } catch (error) {
      fastify.log.error('获取WaveLog状态失败:', error);
      return reply.status(500).send({
        success: false,
        message: error instanceof Error ? error.message : '获取状态失败'
      });
    }
  });
}