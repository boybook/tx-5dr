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

      const qsos = await logBook.provider.queryQSOs(options);

      return reply.send({
        success: true,
        data: qsos
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

      const exportedData = await logBook.provider.exportADIF(options);

      // 设置下载响应头
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${logBook.name}.adi"`);

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