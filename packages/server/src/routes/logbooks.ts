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
  type LogBookInfo,
  type CreateLogBookRequest,
  type UpdateLogBookRequest,
  type ConnectOperatorToLogBookRequest,
  type LogBookQSOQueryOptions,
  type LogBookExportOptions
} from '@tx5dr/contracts';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { LogManager } from '../log/LogManager.js';

/**
 * 日志本管理API路由
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
      fastify.log.error('获取日志本列表失败:', error);
      return reply.status(500).send({
        success: false,
        message: error instanceof Error ? error.message : '获取日志本列表失败'
      });
    }
  });

  /**
   * 获取特定日志本详情
   * GET /api/logbooks/:id
   */
  fastify.get('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const { id } = request.params;
      const logBook = logManager.getLogBook(id);
      
      if (!logBook) {
        return reply.status(404).send({
          success: false,
          message: `日志本 ${id} 不存在`
        });
      }

      // 获取统计信息
      const statistics = await logBook.provider.getStatistics();
      
      // 获取连接的操作员
      const connectedOperators = digitalRadioEngine.operatorManager.getAllOperators()
        .filter(op => logManager.getOperatorLogBookId(op.config.id) === id)
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
      fastify.log.error('获取日志本详情失败:', error);
      return reply.status(500).send({
        success: false,
        message: error instanceof Error ? error.message : '获取日志本详情失败'
      });
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
      fastify.log.error('创建日志本失败:', error);
      return reply.status(400).send({
        success: false,
        message: error instanceof Error ? error.message : '创建日志本失败'
      });
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
      
      const logBook = logManager.getLogBook(id);
      if (!logBook) {
        return reply.status(404).send({
          success: false,
          message: `日志本 ${id} 不存在`
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
      fastify.log.error('更新日志本失败:', error);
      return reply.status(400).send({
        success: false,
        message: error instanceof Error ? error.message : '更新日志本失败'
      });
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
      fastify.log.error('删除日志本失败:', error);
      return reply.status(400).send({
        success: false,
        message: error instanceof Error ? error.message : '删除日志本失败'
      });
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
      fastify.log.error('连接操作员到日志本失败:', error);
      return reply.status(400).send({
        success: false,
        message: error instanceof Error ? error.message : '连接操作员到日志本失败'
      });
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
      fastify.log.error('断开操作员与日志本连接失败:', error);
      return reply.status(400).send({
        success: false,
        message: error instanceof Error ? error.message : '断开操作员与日志本连接失败'
      });
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
      
      const logBook = logManager.getLogBook(id);
      if (!logBook) {
        return reply.status(404).send({
          success: false,
          message: `日志本 ${id} 不存在`
        });
      }

      // 转换查询选项格式以匹配LogQueryOptions接口
      const queryOptions: import('@tx5dr/core').LogQueryOptions = {
        callsign: options.callsign,
        mode: options.mode,
        limit: options.limit,
        orderBy: 'time',
        orderDirection: 'desc'
      };

      // 处理频段过滤（转换为频率范围）
      if (options.band) {
        const bandFreqRanges: Record<string, { min: number; max: number }> = {
          '20m': { min: 14000000, max: 14350000 },
          '40m': { min: 7000000, max: 7300000 },
          '80m': { min: 3500000, max: 4000000 },
          '160m': { min: 1800000, max: 2000000 },
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

      const qsos = await logBook.provider.queryQSOs(queryOptions);

      // 应用分页（provider可能不支持offset分页）
      const offset = options.offset || 0;
      const limit = options.limit || 100;
      const paginatedQsos = qsos.slice(offset, offset + limit);

      return reply.send({
        success: true,
        data: paginatedQsos,
        meta: {
          total: qsos.length,
          offset,
          limit
        }
      });
    } catch (error) {
      fastify.log.error('查询QSO记录失败:', error);
      return reply.status(500).send({
        success: false,
        message: error instanceof Error ? error.message : '查询QSO记录失败'
      });
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
      
      const logBook = logManager.getLogBook(id);
      if (!logBook) {
        return reply.status(404).send({
          success: false,
          message: `日志本 ${id} 不存在`
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
      fastify.log.error('导出日志本失败:', error);
      return reply.status(500).send({
        success: false,
        message: error instanceof Error ? error.message : '导出日志本失败'
      });
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
      
      const logBook = logManager.getLogBook(id);
      if (!logBook) {
        return reply.status(404).send({
          success: false,
          message: `日志本 ${id} 不存在`
        });
      }

      await logBook.provider.importADIF(adifContent, operatorId);

      return reply.send({
        success: true,
        message: '数据导入成功'
      });
    } catch (error) {
      fastify.log.error('导入数据到日志本失败:', error);
      return reply.status(500).send({
        success: false,
        message: error instanceof Error ? error.message : '导入数据到日志本失败'
      });
    }
  });
} 