import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createLogger } from '../utils/logger.js';
import {
  LogBookListResponseSchema,
  LogBookDetailResponseSchema,
  LogBookActionResponseSchema,
  LogBookImportResponseSchema,
  CreateLogBookRequestSchema,
  UpdateLogBookRequestSchema,
  ConnectOperatorToLogBookRequestSchema,
  LogBookQSOQueryOptionsSchema,
  LogBookExportOptionsSchema,
  UpdateQSORequestSchema,
  CreateQSORequestSchema,
  UserRole,
  type LogBookInfo,
  type CreateLogBookRequest,
  type UpdateLogBookRequest,
  type ConnectOperatorToLogBookRequest,
  type LogBookQSOQueryOptions,
  type LogBookExportOptions,
  type LogBookImportFormat,
  type UpdateQSORequest,
  type CreateQSORequest,
  type QSORecord,
} from '@tx5dr/contracts';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ConfigManager } from '../config/config-manager.js';
import { LogQueryOptions } from "@tx5dr/core";
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';
import { requireRole, requireLogbookAccess } from '../auth/authPlugin.js';
import { normalizeCallsign } from '../utils/callsign.js';
import { detectLogImportFormat, normalizeImportText } from '../log/logImportUtils.js';

const logger = createLogger('LogbooksRoute');

function normalizeGridQuery(grid?: string): string | undefined {
  if (!grid) {
    return undefined;
  }

  const normalized = grid.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function getImportPayloadFromBody(body: unknown): {
  content: string;
  format: LogBookImportFormat;
} {
  const payload = body as { adifContent?: string } | undefined;
  const content = normalizeImportText(payload?.adifContent || '');
  if (!content) {
    throw new RadioError({
      code: RadioErrorCode.INVALID_OPERATION,
      message: 'Missing logbook import content',
      userMessage: 'Import file content is empty',
      severity: RadioErrorSeverity.WARNING,
      suggestions: ['Select a non-empty ADIF file and try again'],
    });
  }

  return {
    content,
    format: 'adif',
  };
}

/**
 * 日志本管理API路由
 * 📊 Day14优化：统一错误处理，使用 RadioError + Fastify 全局错误处理器
 */
export async function logbookRoutes(fastify: FastifyInstance) {
  const digitalRadioEngine = DigitalRadioEngine.getInstance();
  const logManager = digitalRadioEngine.operatorManager.getLogManager();

  // 日志本归属校验 preHandler（复用于所有带 :id 的路由）
  const logbookAccessCheck = requireLogbookAccess(logManager);
  // ADMIN only preHandler
  const adminOnly = requireRole(UserRole.ADMIN);

  /**
   * 获取所有日志本列表（按角色过滤）
   * GET /api/logbooks
   */
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // ADMIN 看全部（含孤儿日志本），OPERATOR 只看自己呼号关联的日志本
      const authUser = request.authUser!;
      let logBooks;
      if (authUser.role === UserRole.ADMIN) {
        logBooks = logManager.getLogBooks();
      } else {
        // 构建用户归一化呼号集合
        const operatorsConfig = ConfigManager.getInstance().getOperatorsConfig();
        const userCallsigns = new Set<string>();
        for (const op of operatorsConfig) {
          if (authUser.operatorIds.includes(op.id)) {
            userCallsigns.add(normalizeCallsign(op.myCallsign));
          }
        }
        logBooks = logManager.getAccessibleLogBooksByCallsigns(userCallsigns);
      }

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
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: [logbookAccessCheck] }, async (request, reply) => {
    try {
      const { id } = request.params;
      let logBook = logManager.getLogBook(id);
      
      // 如果直接ID查找失败，尝试按呼号查找或创建
      if (!logBook) {
        try {
          logBook = await logManager.getOrCreateLogBookByCallsign(id);
        } catch (error) {
          logger.warn(`Failed to create log book for callsign ${id}:`, error);
        }
      }

      if (!logBook) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `Logbook ${id} does not exist`,
          userMessage: 'Logbook not found',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['Check if logbook ID is correct', 'View available logbooks'],
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
            firstQSO: statistics.firstQSOTime ? new Date(statistics.firstQSOTime).toISOString() : undefined,
            dxcc: statistics.dxcc,
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
        message: 'Logbook created successfully',
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
  fastify.put<{ Params: { id: string }; Body: UpdateLogBookRequest }>('/:id', { preHandler: [logbookAccessCheck] }, async (request, reply) => {
    try {
      const { id } = request.params;
      const updates = UpdateLogBookRequestSchema.parse(request.body);
      
      let logBook = logManager.getLogBook(id);
      
      // 如果直接ID查找失败，尝试按呼号查找或创建
      if (!logBook) {
        try {
          logBook = await logManager.getOrCreateLogBookByCallsign(id);
        } catch (error) {
          logger.warn(`Failed to create log book for callsign ${id}:`, error);
        }
      }


      if (!logBook) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `Logbook ${id} does not exist`,
          userMessage: 'Logbook not found',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['Check if logbook ID is correct', 'View available logbooks'],
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
        message: 'Logbook updated successfully',
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
   * 删除日志本（仅 ADMIN）
   * DELETE /api/logbooks/:id
   */
  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: [adminOnly] }, async (request, reply) => {
    try {
      const { id } = request.params;
      
      await logManager.deleteLogBook(id);

      return reply.send({
        success: true,
        message: 'Logbook deleted successfully'
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 连接操作员到日志本（仅 ADMIN）
   * POST /api/logbooks/:id/connect
   */
  fastify.post<{ Params: { id: string }; Body: ConnectOperatorToLogBookRequest }>('/:id/connect', { preHandler: [adminOnly] }, async (request, reply) => {
    try {
      const { id: logBookId } = request.params;
      const { operatorId } = ConnectOperatorToLogBookRequestSchema.parse(request.body);
      
      await digitalRadioEngine.operatorManager.connectOperatorToLogBook(operatorId, logBookId);

      return reply.send({
        success: true,
        message: `Operator ${operatorId} connected to logbook ${logBookId}`
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 断开操作员与日志本的连接（仅 ADMIN）
   * POST /api/logbooks/disconnect/:operatorId
   */
  fastify.post<{ Params: { operatorId: string } }>('/disconnect/:operatorId', { preHandler: [adminOnly] }, async (request, reply) => {
    try {
      const { operatorId } = request.params;
      
      digitalRadioEngine.operatorManager.disconnectOperatorFromLogBook(operatorId);

      return reply.send({
        success: true,
        message: `Operator ${operatorId} disconnected from logbook`
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
  fastify.get<{ Params: { id: string }; Querystring: LogBookQSOQueryOptions }>('/:id/qsos', { preHandler: [logbookAccessCheck] }, async (request, reply) => {
    try {
      const { id } = request.params;
      const options = LogBookQSOQueryOptionsSchema.parse(request.query);
      
      let logBook = logManager.getLogBook(id);
      
      // 如果直接ID查找失败，尝试按呼号查找或创建
      if (!logBook) {
        try {
          logBook = await logManager.getOrCreateLogBookByCallsign(id);
        } catch (error) {
          logger.warn(`Failed to create log book for callsign ${id}:`, error);
        }
      }


      if (!logBook) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `Logbook ${id} does not exist`,
          userMessage: 'Logbook not found',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['Check if logbook ID is correct', 'View available logbooks'],
        });
      }

      // 转换查询选项格式以匹配LogQueryOptions接口
      const queryOptions: LogQueryOptions = {
        callsign: options.callsign,
        grid: normalizeGridQuery(options.grid),
        mode: options.mode,
        excludeModes: options.excludeModes
          ? options.excludeModes.split(',').map(m => m.trim()).filter(Boolean)
          : undefined,
        qslStatus: options.qslStatus,
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
      
      logger.debug('Pagination request params:', {
        requestLimit,
        requestOffset,
        filterOptions: Object.keys(filterOptions),
      });
      
      // 先获取不带分页限制的筛选后总数
      const allFilteredQsos = await logBook.provider.queryQSOs(filterOptions);
      const totalFiltered = allFilteredQsos.length;

      // 应用分页（provider可能不支持offset分页）
      const offset = requestOffset || 0;
      const limit = requestLimit || 100;
      const paginatedQsos = allFilteredQsos.slice(offset, offset + limit);
      
      logger.debug('Pagination result:', {
        totalFiltered,
        offset,
        limit,
        paginatedCount: paginatedQsos.length,
        firstRecordId: paginatedQsos[0]?.id,
        firstRecordCallsign: paginatedQsos[0]?.callsign,
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
  fastify.get<{ Params: { id: string }; Querystring: LogBookExportOptions }>('/:id/export', { preHandler: [logbookAccessCheck] }, async (request, reply) => {
    try {
      const { id } = request.params;
      const options = LogBookExportOptionsSchema.parse(request.query);
      
      let logBook = logManager.getLogBook(id);
      
      // 如果直接ID查找失败，尝试按呼号查找或创建
      if (!logBook) {
        try {
          logBook = await logManager.getOrCreateLogBookByCallsign(id);
        } catch (error) {
          logger.warn(`Failed to create log book for callsign ${id}:`, error);
        }
      }


      if (!logBook) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `Logbook ${id} does not exist`,
          userMessage: 'Logbook not found',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['Check if logbook ID is correct', 'View available logbooks'],
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
        const stationGrid = ConfigManager.getInstance().getStationInfo().qth?.grid;
        exportedData = await logBook.provider.exportADIF(queryOptions, { fallbackGrid: stationGrid });
      }
      
      // 确保返回的是字符串
      if (typeof exportedData !== 'string') {
        fastify.log.error({ type: typeof exportedData }, 'Export method returned non-string type');
        throw new Error('Export data format error');
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
  fastify.post<{ Params: { id: string }; Body: { adifContent?: string } }>('/:id/import', { preHandler: [logbookAccessCheck] }, async (request, reply) => {
    try {
      const { id } = request.params;
      let content: string;
      let format: LogBookImportFormat;

      if (request.isMultipart()) {
        const file = await request.file();
        if (!file) {
          throw new RadioError({
            code: RadioErrorCode.INVALID_OPERATION,
            message: 'Missing import file',
            userMessage: 'Please select an import file',
            severity: RadioErrorSeverity.WARNING,
            suggestions: ['Choose an ADI, ADIF, or CSV file and try again'],
          });
        }

        const buffer = await file.toBuffer();
        content = normalizeImportText(buffer.toString('utf-8'));
        if (!content) {
          throw new RadioError({
            code: RadioErrorCode.INVALID_OPERATION,
            message: 'Import file is empty',
            userMessage: 'The selected import file is empty',
            severity: RadioErrorSeverity.WARNING,
            suggestions: ['Choose a non-empty ADI, ADIF, or CSV file'],
          });
        }
        format = detectLogImportFormat(content, file.filename);
      } else {
        const payload = getImportPayloadFromBody(request.body);
        content = payload.content;
        format = payload.format;
      }

      let logBook = logManager.getLogBook(id);

      // 如果直接ID查找失败,尝试按呼号查找或创建
      if (!logBook) {
        try {
          logBook = await logManager.getOrCreateLogBookByCallsign(id);
        } catch (error) {
          logger.warn(`Failed to create log book for callsign ${id}:`, error);
        }
      }

      if (!logBook) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `Logbook ${id} does not exist`,
          userMessage: 'Logbook not found',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['Check if logbook ID is correct', 'View available logbooks'],
        });
      }

      const result = format === 'csv'
        ? await logBook.provider.importCSV(content)
        : await logBook.provider.importADIF(content);

      if (result.imported > 0 || result.merged > 0) {
        try {
          const statistics = await logBook.provider.getStatistics();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          digitalRadioEngine.emit('logbookUpdated' as any, {
            logBookId: logBook.id,
            statistics,
          });
        } catch (statsError) {
          logger.warn('Failed to emit logbook update after import:', statsError);
        }
      }

      const response = LogBookImportResponseSchema.parse({
        success: true,
        message: 'Logbook import completed',
        data: result,
      });

      return reply.send(response);
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 手动补录 QSO 记录
   * POST /api/logbooks/:id/qsos
   */
  fastify.post<{ Params: { id: string }; Body: CreateQSORequest }>('/:id/qsos', { preHandler: [logbookAccessCheck] }, async (request, reply) => {
    try {
      const { id } = request.params;
      const body = CreateQSORequestSchema.parse(request.body);

      // 支持以呼号作为 id 参数（同 PUT 路由）
      let logBook = logManager.getLogBook(id);
      if (!logBook) {
        try {
          logBook = await logManager.getOrCreateLogBookByCallsign(id);
        } catch {
          throw new RadioError({
            code: RadioErrorCode.RESOURCE_UNAVAILABLE,
            message: `Logbook ${id} does not exist`,
            userMessage: 'Logbook not found',
            severity: RadioErrorSeverity.WARNING,
            suggestions: ['Check if logbook ID is correct'],
          });
        }
      }

      const logbookCallsign = logManager.getCallsignsForLogBook(logBook.id)[0];
      const linkedOperator = logbookCallsign
        ? digitalRadioEngine.operatorManager.getAllOperators()
          .find(op => normalizeCallsign(op.config.myCallsign) === logbookCallsign)
        : undefined;
      const operatorId = linkedOperator?.config.id;
      const myCallsign = logbookCallsign || linkedOperator?.config.myCallsign;
      const stationGrid = ConfigManager.getInstance().getStationInfo().qth?.grid;
      const myGrid = linkedOperator?.config.myGrid || stationGrid;

      // 构造 QSORecord，id 格式与自动记录保持一致
      const ownerKey = myCallsign ? normalizeCallsign(myCallsign) : 'manual';
      const newId = `${body.callsign}_${body.startTime}_${Date.now()}_${ownerKey}`;
      const record: QSORecord = {
        id: newId,
        ...body,
        myCallsign,
        myGrid,
      };

      await logBook.provider.addQSO(record);
      const created = await logBook.provider.getQSO(newId);

      logger.info('QSO record created manually', { logBookId: logBook.id, callsign: body.callsign, operatorId });

      // 广播 qsoRecordAdded 事件（触发 WS 推送和前端实时更新）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      digitalRadioEngine.emit('qsoRecordAdded' as any, {
        operatorId: operatorId || '',
        logBookId: logBook.id,
        qsoRecord: record,
      });
      try {
        const statistics = await logBook.provider.getStatistics();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        digitalRadioEngine.emit('logbookUpdated' as any, {
          logBookId: logBook.id,
          statistics,
          operatorId: operatorId || '',
        });
      } catch (statsError) {
        logger.warn('Failed to get logbook statistics after manual QSO creation:', statsError);
      }

      // 自动同步到外部服务（WaveLog / QRZ）
      if (myCallsign && operatorId) {
        digitalRadioEngine.operatorManager.triggerAutoSync(record, myCallsign, operatorId).catch((err) => {
          logger.warn('Auto-sync failed for manually created QSO:', err);
        });
      }

      return reply.status(201).send({
        success: true,
        message: 'QSO record created',
        data: created,
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 更新单条QSO记录
   * PUT /api/logbooks/:id/qsos/:qsoId
   */
  fastify.put<{ Params: { id: string; qsoId: string }; Body: UpdateQSORequest }>('/:id/qsos/:qsoId', { preHandler: [logbookAccessCheck] }, async (request, reply) => {
    try {
      const { id, qsoId } = request.params;
      const updates = UpdateQSORequestSchema.parse(request.body);

      let logBook = logManager.getLogBook(id);

      // 如果直接ID查找失败,尝试按呼号查找或创建
      if (!logBook) {
        try {
          logBook = await logManager.getOrCreateLogBookByCallsign(id);
        } catch (error) {
          logger.warn(`Failed to create log book for callsign ${id}:`, error);
        }
      }

      if (!logBook) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `Logbook ${id} does not exist`,
          userMessage: 'Logbook not found',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['Check if logbook ID is correct', 'View available logbooks'],
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
          message: `QSO record ${qsoId} does not exist`,
          userMessage: 'QSO record not found',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['Check if QSO record ID is correct', 'Refresh logbook data'],
        });
      }

      return reply.send({
        success: true,
        message: 'QSO record updated successfully',
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
  fastify.delete<{ Params: { id: string; qsoId: string } }>('/:id/qsos/:qsoId', { preHandler: [logbookAccessCheck] }, async (request, reply) => {
    try {
      const { id, qsoId } = request.params;

      let logBook = logManager.getLogBook(id);

      // 如果直接ID查找失败,尝试按呼号查找或创建
      if (!logBook) {
        try {
          logBook = await logManager.getOrCreateLogBookByCallsign(id);
        } catch (error) {
          logger.warn(`Failed to create log book for callsign ${id}:`, error);
        }
      }

      if (!logBook) {
        // 📊 Day14：资源未找到使用 RadioError
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `Logbook ${id} does not exist`,
          userMessage: 'Logbook not found',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['Check if logbook ID is correct', 'View available logbooks'],
        });
      }

      // 删除QSO记录
      await logBook.provider.deleteQSO(qsoId);

      return reply.send({
        success: true,
        message: 'QSO record deleted successfully'
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 获取日志本数据目录路径（仅 ADMIN）
   * GET /api/logbooks/data-path
   */
  fastify.get('/data-path', { preHandler: [adminOnly] }, async (_request: FastifyRequest, reply: FastifyReply) => {
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
