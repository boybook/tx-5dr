import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  LogBookListResponseSchema,
  LogBookDetailResponseSchema,
  LogBookActionResponseSchema,
  CreateLogBookRequestSchema,
  UpdateLogBookRequestSchema,
  ConnectOperatorToLogBookRequestSchema,
  LogBookQSOQueryOptionsSchema,
  LogBookExportOptionsSchema,
  UpdateQSORequestSchema,
  QSOActionResponseSchema,
  type LogBookInfo,
  type CreateLogBookRequest,
  type UpdateLogBookRequest,
  type ConnectOperatorToLogBookRequest,
  type LogBookQSOQueryOptions,
  type LogBookExportOptions,
  type UpdateQSORequest,
  type QSOActionResponse
} from '@tx5dr/contracts';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { LogQueryOptions } from "@tx5dr/core";
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';

/**
 * 日志本管理API路由
 * 📊 Day14优化：统一错误处理，使用 RadioError + Fastify 全局错误处理器
 */
export async function logbookRoutes(fastify: FastifyInstance) {
  const digitalRadioEngine = DigitalRadioEngine.getInstance();
  const logManager = digitalRadioEngine.operatorManager.getLogManager();

  /**
   * 获取所有日志本列表
   * GET /api/logbooks
   */
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const logBooks = logManager.getLogBooks();
      
      // 转换为API格式
      const logBookInfos: LogBookInfo[] = logBooks.map(book => ({
        id: book.id,
        name: book.name,
        description: book.description,
        filePath: book.filePath,
        createdAt: book.createdAt,
        lastUsed: book.lastUsed,
        isActive: book.isActive
      }));

      const response = LogBookListResponseSchema.parse({
        success: true,
        data: logBookInfos
      });

      return reply.send(response);
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 获取特定日志本详情
   * GET /api/logbooks/:id
   */
  fastify.get('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const { id } = request.params;
      let logBook = logManager.getLogBook(id);
      
      // 如果直接ID查找失败，尝试按呼号查找或创建
      if (!logBook) {
        try {
          logBook = await logManager.getOrCreateLogBookByCallsign(id);
        } catch (error) {
          console.warn(`📋 [API] 无法为呼号 ${id} 创建日志本:`, error);
        }
      }

      if (!logBook) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `日志本 ${id} 不存在`,
          userMessage: '未找到指定的日志本',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['检查日志本ID是否正确', '查看可用的日志本列表'],
        });
      }

      // 获取统计信息
      const statistics = await logBook.provider.getStatistics();
      
      // 获取连接的操作员
      const connectedOperators = digitalRadioEngine.operatorManager.getAllOperators()
        .filter(op => {
          const logBookId = logManager.getOperatorLogBookId(op.config.id);
          return logBookId === id;
        })
        .map(op => op.config.id);

      const response = LogBookDetailResponseSchema.parse({
        success: true,
        data: {
          id: logBook.id,
          name: logBook.name,
          description: logBook.description,
          filePath: logBook.filePath,
          createdAt: logBook.createdAt,
          lastUsed: logBook.lastUsed,
          isActive: logBook.isActive,
          statistics: {
            totalQSOs: statistics.totalQSOs || 0,
            totalOperators: connectedOperators.length,
            uniqueCallsigns: statistics.uniqueCallsigns || 0,
            lastQSO: statistics.lastQSOTime ? new Date(statistics.lastQSOTime).toISOString() : undefined,
            firstQSO: undefined // 需要从provider获取第一次QSO时间
          },
          connectedOperators
        }
      });

      return reply.send(response);
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 创建新日志本
   * POST /api/logbooks
   */
  fastify.post('/', async (request: FastifyRequest<{ Body: CreateLogBookRequest }>, reply: FastifyReply) => {
    try {
      const requestData = CreateLogBookRequestSchema.parse(request.body);
      
      const logBook = await logManager.createLogBook(requestData);

      const response = LogBookActionResponseSchema.parse({
        success: true,
        message: '日志本创建成功',
        data: {
          id: logBook.id,
          name: logBook.name,
          description: logBook.description,
          filePath: logBook.filePath,
          createdAt: logBook.createdAt,
          lastUsed: logBook.lastUsed,
          isActive: logBook.isActive
        }
      });

      return reply.status(201).send(response);
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  /**
   * 更新日志本信息
   * PUT /api/logbooks/:id
   */
  fastify.put('/:id', async (request: FastifyRequest<{ Params: { id: string }; Body: UpdateLogBookRequest }>, reply: FastifyReply) => {
    try {
      const { id } = request.params;
      const updates = UpdateLogBookRequestSchema.parse(request.body);
      
      let logBook = logManager.getLogBook(id);
      
      // 如果直接ID查找失败，尝试按呼号查找或创建
      if (!logBook) {
        try {
          logBook = await logManager.getOrCreateLogBookByCallsign(id);
        } catch (error) {
          console.warn(`📋 [API] 无法为呼号 ${id} 创建日志本:`, error);
        }
      }


      if (!logBook) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `日志本 ${id} 不存在`,
          userMessage: '未找到指定的日志本',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['检查日志本ID是否正确', '查看可用的日志本列表'],
        });
      }

      // 更新日志本属性
      if (updates.name !== undefined) {
        logBook.name = updates.name;
      }
      if (updates.description !== undefined) {
        logBook.description = updates.description;
      }
      if (updates.isActive !== undefined) {
        logBook.isActive = updates.isActive;
      }

      const response = LogBookActionResponseSchema.parse({
        success: true,
        message: '日志本更新成功',
        data: {
          id: logBook.id,
          name: logBook.name,
          description: logBook.description,
          filePath: logBook.filePath,
          createdAt: logBook.createdAt,
          lastUsed: logBook.lastUsed,
          isActive: logBook.isActive
        }
      });

      return reply.send(response);
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  /**
   * 删除日志本
   * DELETE /api/logbooks/:id
   */
  fastify.delete('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const { id } = request.params;
      
      await logManager.deleteLogBook(id);

      return reply.send({
        success: true,
        message: '日志本删除成功'
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 连接操作员到日志本
   * POST /api/logbooks/:id/connect
   */
  fastify.post('/:id/connect', async (request: FastifyRequest<{ Params: { id: string }; Body: ConnectOperatorToLogBookRequest }>, reply: FastifyReply) => {
    try {
      const { id: logBookId } = request.params;
      const { operatorId } = ConnectOperatorToLogBookRequestSchema.parse(request.body);
      
      await digitalRadioEngine.operatorManager.connectOperatorToLogBook(operatorId, logBookId);

      return reply.send({
        success: true,
        message: `操作员 ${operatorId} 已连接到日志本 ${logBookId}`
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 断开操作员与日志本的连接
   * POST /api/logbooks/disconnect/:operatorId
   */
  fastify.post('/disconnect/:operatorId', async (request: FastifyRequest<{ Params: { operatorId: string } }>, reply: FastifyReply) => {
    try {
      const { operatorId } = request.params;
      
      digitalRadioEngine.operatorManager.disconnectOperatorFromLogBook(operatorId);

      return reply.send({
        success: true,
        message: `操作员 ${operatorId} 已断开与日志本的连接`
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 查询日志本中的QSO记录
   * GET /api/logbooks/:id/qsos
   */
  fastify.get('/:id/qsos', async (request: FastifyRequest<{ Params: { id: string }; Querystring: LogBookQSOQueryOptions }>, reply: FastifyReply) => {
    try {
      const { id } = request.params;
      const options = LogBookQSOQueryOptionsSchema.parse(request.query);
      
      let logBook = logManager.getLogBook(id);
      
      // 如果直接ID查找失败，尝试按呼号查找或创建
      if (!logBook) {
        try {
          logBook = await logManager.getOrCreateLogBookByCallsign(id);
        } catch (error) {
          console.warn(`📋 [API] 无法为呼号 ${id} 创建日志本:`, error);
        }
      }


      if (!logBook) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `日志本 ${id} 不存在`,
          userMessage: '未找到指定的日志本',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['检查日志本ID是否正确', '查看可用的日志本列表'],
        });
      }

      // 转换查询选项格式以匹配LogQueryOptions接口
      const queryOptions: LogQueryOptions = {
        callsign: options.callsign,
        mode: options.mode,
        limit: options.limit,
        offset: options.offset,
        orderBy: 'time',
        orderDirection: 'desc'
      };

      // 处理频段过滤（转换为频率范围）
      if (options.band) {
        const bandFreqRanges: Record<string, { min: number; max: number }> = {
          '160m': { min: 1800000, max: 2000000 },
          '80m': { min: 3500000, max: 4000000 },
          '60m': { min: 5000000, max: 5500000 },
          '40m': { min: 7000000, max: 7300000 },
          '30m': { min: 10100000, max: 10150000 },
          '20m': { min: 14000000, max: 14350000 },
          '17m': { min: 18068000, max: 18168000 },
          '15m': { min: 21000000, max: 21450000 },
          '12m': { min: 24890000, max: 24990000 },
          '10m': { min: 28000000, max: 29700000 },
          '6m': { min: 50000000, max: 54000000 },
          '4m': { min: 70000000, max: 71000000 },
          '2m': { min: 144000000, max: 148000000 },
          '1.25m': { min: 222000000, max: 225000000 },
          '70cm': { min: 420000000, max: 450000000 },
          '33cm': { min: 902000000, max: 928000000 },
          '23cm': { min: 1240000000, max: 1300000000 },
        };

        if (bandFreqRanges[options.band]) {
          queryOptions.frequencyRange = bandFreqRanges[options.band];
        }
      }

      // 处理日期范围过滤（转换为时间戳）
      if (options.startDate || options.endDate) {
        const startTime = options.startDate ? new Date(options.startDate).getTime() : 0;
        let endTime = Date.now();
        
        if (options.endDate) {
          // 结束日期包含整天，所以设置为当天23:59:59
          const endDate = new Date(options.endDate);
          endDate.setHours(23, 59, 59, 999);
          endTime = endDate.getTime();
        }
        
        queryOptions.timeRange = {
          start: startTime,
          end: endTime
        };
      }

      // 分离分页参数和筛选参数
      const { limit: requestLimit, offset: requestOffset, ...filterOptions } = queryOptions;
      
      console.log(`📊 [LogBook API] 分页请求参数:`, {
        requestLimit,
        requestOffset,
        filterOptions: Object.keys(filterOptions)
      });
      
      // 先获取不带分页限制的筛选后总数
      const allFilteredQsos = await logBook.provider.queryQSOs(filterOptions);
      const totalFiltered = allFilteredQsos.length;

      // 应用分页（provider可能不支持offset分页）
      const offset = requestOffset || 0;
      const limit = requestLimit || 100;
      const paginatedQsos = allFilteredQsos.slice(offset, offset + limit);
      
      console.log(`📊 [LogBook API] 分页处理结果:`, {
        totalFiltered,
        offset,
        limit,
        paginatedCount: paginatedQsos.length,
        firstRecordId: paginatedQsos[0]?.id,
        firstRecordCallsign: paginatedQsos[0]?.callsign
      });

      // 同时获取不带任何筛选的总记录数（用于统计显示）
      const baseQueryOptions = { operatorId: filterOptions.operatorId };
      const allQsos = await logBook.provider.queryQSOs(baseQueryOptions);
      const totalRecords = allQsos.length;

      return reply.send({
        success: true,
        data: paginatedQsos,
        meta: {
          total: totalFiltered, // 筛选后的总数（用于分页计算）
          totalRecords, // 总记录数（用于统计显示）
          offset,
          limit,
          hasFilters: Object.keys(filterOptions).some(key => 
            key !== 'operatorId' && filterOptions[key as keyof typeof filterOptions] !== undefined
          )
        }
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 导出日志本数据
   * GET /api/logbooks/:id/export
   */
  fastify.get('/:id/export', async (request: FastifyRequest<{ Params: { id: string }; Querystring: LogBookExportOptions }>, reply: FastifyReply) => {
    try {
      const { id } = request.params;
      const options = LogBookExportOptionsSchema.parse(request.query);
      
      let logBook = logManager.getLogBook(id);
      
      // 如果直接ID查找失败，尝试按呼号查找或创建
      if (!logBook) {
        try {
          logBook = await logManager.getOrCreateLogBookByCallsign(id);
        } catch (error) {
          console.warn(`📋 [API] 无法为呼号 ${id} 创建日志本:`, error);
        }
      }


      if (!logBook) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `日志本 ${id} 不存在`,
          userMessage: '未找到指定的日志本',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['检查日志本ID是否正确', '查看可用的日志本列表'],
        });
      }

      // 将LogBookExportOptions转换为LogQueryOptions
      const queryOptions: import('@tx5dr/core').LogQueryOptions = {
        callsign: options.callsign,
        orderBy: 'time',
        orderDirection: 'desc'
      };

      // 处理频段过滤（暂时不支持，因为ExportOptions中没有band字段）
      
      // 处理日期范围过滤
      if (options.startDate || options.endDate) {
        const startTime = options.startDate ? new Date(options.startDate).getTime() : 0;
        let endTime = Date.now();
        
        if (options.endDate) {
          // 结束日期包含整天，所以设置为当天23:59:59
          const endDate = new Date(options.endDate);
          endDate.setHours(23, 59, 59, 999);
          endTime = endDate.getTime();
        }
        
        queryOptions.timeRange = {
          start: startTime,
          end: endTime
        };
      }

      // 根据格式选择导出方法
      let exportedData: string;
      if (options.format === 'csv') {
        exportedData = await logBook.provider.exportCSV(queryOptions);
      } else {
        exportedData = await logBook.provider.exportADIF(queryOptions);
      }
      
      // 确保返回的是字符串
      if (typeof exportedData !== 'string') {
        fastify.log.error('导出方法返回了非字符串类型:', typeof exportedData, exportedData);
        throw new Error('导出数据格式错误');
      }

      // 设置正确的MIME类型和文件扩展名
      const fileExtension = options.format === 'csv' ? 'csv' : 'adi';
      const mimeType = options.format === 'csv' ? 'text/csv' : 'application/octet-stream';
      
      // 清理文件名中的非ASCII字符，避免Content-Disposition头部错误
      const sanitizedFileName = logBook.name.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, '_') || 'logbook';
      const fileName = `${sanitizedFileName}.${fileExtension}`;
      
      reply.header('Content-Type', mimeType);
      reply.header('Content-Disposition', `attachment; filename="${fileName}"`);

      return reply.send(exportedData);
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 导入数据到日志本
   * POST /api/logbooks/:id/import
   */
  fastify.post('/:id/import', async (request: FastifyRequest<{ Params: { id: string }; Body: { adifContent: string; operatorId?: string } }>, reply: FastifyReply) => {
    try {
      const { id } = request.params;
      const { adifContent, operatorId } = request.body;

      let logBook = logManager.getLogBook(id);

      // 如果直接ID查找失败,尝试按呼号查找或创建
      if (!logBook) {
        try {
          logBook = await logManager.getOrCreateLogBookByCallsign(id);
        } catch (error) {
          console.warn(`📋 [API] 无法为呼号 ${id} 创建日志本:`, error);
        }
      }

      if (!logBook) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `日志本 ${id} 不存在`,
          userMessage: '未找到指定的日志本',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['检查日志本ID是否正确', '查看可用的日志本列表'],
        });
      }

      await logBook.provider.importADIF(adifContent, operatorId);

      return reply.send({
        success: true,
        message: '数据导入成功'
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 更新单条QSO记录
   * PUT /api/logbooks/:id/qsos/:qsoId
   */
  fastify.put('/:id/qsos/:qsoId', async (request: FastifyRequest<{ Params: { id: string; qsoId: string }; Body: UpdateQSORequest }>, reply: FastifyReply) => {
    try {
      const { id, qsoId } = request.params;
      const updates = UpdateQSORequestSchema.parse(request.body);

      let logBook = logManager.getLogBook(id);

      // 如果直接ID查找失败,尝试按呼号查找或创建
      if (!logBook) {
        try {
          logBook = await logManager.getOrCreateLogBookByCallsign(id);
        } catch (error) {
          console.warn(`📋 [API] 无法为呼号 ${id} 创建日志本:`, error);
        }
      }

      if (!logBook) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `日志本 ${id} 不存在`,
          userMessage: '未找到指定的日志本',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['检查日志本ID是否正确', '查看可用的日志本列表'],
        });
      }

      // 更新QSO记录
      await logBook.provider.updateQSO(qsoId, updates);

      // 获取更新后的记录
      const updatedQSO = await logBook.provider.getQSO(qsoId);

      if (!updatedQSO) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `QSO记录 ${qsoId} 不存在`,
          userMessage: '未找到指定的QSO记录',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['检查QSO记录ID是否正确', '刷新日志本数据'],
        });
      }

      return reply.send({
        success: true,
        message: 'QSO记录更新成功',
        data: updatedQSO
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 删除单条QSO记录
   * DELETE /api/logbooks/:id/qsos/:qsoId
   */
  fastify.delete('/:id/qsos/:qsoId', async (request: FastifyRequest<{ Params: { id: string; qsoId: string } }>, reply: FastifyReply) => {
    try {
      const { id, qsoId } = request.params;

      let logBook = logManager.getLogBook(id);

      // 如果直接ID查找失败,尝试按呼号查找或创建
      if (!logBook) {
        try {
          logBook = await logManager.getOrCreateLogBookByCallsign(id);
        } catch (error) {
          console.warn(`📋 [API] 无法为呼号 ${id} 创建日志本:`, error);
        }
      }

      if (!logBook) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `日志本 ${id} 不存在`,
          userMessage: '未找到指定的日志本',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['检查日志本ID是否正确', '查看可用的日志本列表'],
        });
      }

      // 删除QSO记录
      await logBook.provider.deleteQSO(qsoId);

      return reply.send({
        success: true,
        message: 'QSO记录删除成功'
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 获取日志本数据目录路径
   * GET /api/logbooks/data-path
   */
  fastify.get('/data-path', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { tx5drPaths } = await import('../utils/app-paths.js');
      const dataDir = await tx5drPaths.getDataDir();
      const logbookDir = (await import('path')).join(dataDir, 'logbook');

      return reply.send({
        success: true,
        path: logbookDir
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
}