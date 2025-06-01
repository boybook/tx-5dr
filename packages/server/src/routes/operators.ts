import { FastifyInstance } from 'fastify';
import { ConfigManager } from '../config/config-manager';
import { DigitalRadioEngine } from '../DigitalRadioEngine';
import { 
  RadioOperatorListResponseSchema,
  RadioOperatorDetailResponseSchema,
  RadioOperatorActionResponseSchema,
  CreateRadioOperatorRequestSchema,
  UpdateRadioOperatorRequestSchema,
  type CreateRadioOperatorRequest,
  type UpdateRadioOperatorRequest 
} from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';

export async function operatorRoutes(fastify: FastifyInstance) {
  const configManager = ConfigManager.getInstance();
  const engine = DigitalRadioEngine.getInstance();

  // 获取所有操作员配置
  fastify.get('/', async (request, reply) => {
    try {
      const operators = configManager.getOperatorsConfig();
      
      const response = RadioOperatorListResponseSchema.parse({
        success: true,
        data: operators
      });
      
      return reply.code(200).send(response);
    } catch (error: any) {
      fastify.log.error('获取操作员列表失败:', error);
      return reply.code(500).send({
        success: false,
        message: '获取操作员列表失败',
        error: error.message
      });
    }
  });

  // 获取指定操作员配置
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const operator = configManager.getOperatorConfig(id);
      
      if (!operator) {
        return reply.code(404).send({
          success: false,
          message: `操作员 ${id} 不存在`
        });
      }
      
      const response = RadioOperatorDetailResponseSchema.parse({
        success: true,
        data: operator
      });
      
      return reply.code(200).send(response);
    } catch (error: any) {
      fastify.log.error('获取操作员详情失败:', error);
      return reply.code(500).send({
        success: false,
        message: '获取操作员详情失败',
        error: error.message
      });
    }
  });

  // 创建新操作员
  fastify.post<{ Body: CreateRadioOperatorRequest }>('/', {
    schema: {
      body: zodToJsonSchema(CreateRadioOperatorRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const operatorData = CreateRadioOperatorRequestSchema.parse(request.body);
      
      // 检查呼号是否已存在
      const existingOperators = configManager.getOperatorsConfig();
      const callsignExists = existingOperators.some(op => op.myCallsign === operatorData.myCallsign);
      if (callsignExists) {
        return reply.code(400).send({
          success: false,
          message: `呼号 ${operatorData.myCallsign} 已存在`
        });
      }
      
      // 创建操作员配置，确保所有必需字段都存在
      const newOperatorData = {
        ...operatorData,
        mode: operatorData.mode || MODES.FT8,
        myGrid: operatorData.myGrid || '',  // 确保myGrid不为undefined
      };
      
      const newOperator = await configManager.addOperatorConfig(newOperatorData);
      
      // 如果引擎正在运行，同步添加到引擎中
      try {
        await engine.syncAddOperator(newOperator);
        fastify.log.info(`📻 [API] 创建操作员: ${newOperator.id} (${newOperator.myCallsign})`);
      } catch (engineError) {
        fastify.log.warn(`📻 [API] 操作员配置已保存，但添加到引擎失败: ${engineError}`);
      }
      
      const response = RadioOperatorActionResponseSchema.parse({
        success: true,
        message: '操作员创建成功',
        data: newOperator
      });
      
      return reply.code(201).send(response);
    } catch (error: any) {
      fastify.log.error('创建操作员失败:', error);
      
      if (error.name === 'ZodError') {
        return reply.code(400).send({
          success: false,
          message: '请求数据格式错误',
          errors: error.errors
        });
      }
      
      return reply.code(500).send({
        success: false,
        message: '创建操作员失败',
        error: error.message
      });
    }
  });

  // 更新操作员配置
  fastify.put<{ Params: { id: string }; Body: UpdateRadioOperatorRequest }>('/:id', {
    schema: {
      body: zodToJsonSchema(UpdateRadioOperatorRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const updates = UpdateRadioOperatorRequestSchema.parse(request.body);
      
      // 检查呼号是否与其他操作员冲突
      if (updates.myCallsign) {
        const existingOperators = configManager.getOperatorsConfig();
        const callsignExists = existingOperators.some(op => op.id !== id && op.myCallsign === updates.myCallsign);
        if (callsignExists) {
          return reply.code(400).send({
            success: false,
            message: `呼号 ${updates.myCallsign} 已被其他操作员使用`
          });
        }
      }
      
      // 更新配置
      const updatedOperator = await configManager.updateOperatorConfig(id, updates);
      
      // 同步更新到引擎中
      try {
        await engine.syncUpdateOperator(updatedOperator);
        fastify.log.info(`📻 [API] 更新操作员: ${id} (${updatedOperator.myCallsign})`);
      } catch (engineError) {
        fastify.log.warn(`📻 [API] 操作员配置已更新，但同步到引擎失败: ${engineError}`);
      }
      
      const response = RadioOperatorActionResponseSchema.parse({
        success: true,
        message: '操作员更新成功',
        data: updatedOperator
      });
      
      return reply.code(200).send(response);
    } catch (error: any) {
      fastify.log.error('更新操作员失败:', error);
      
      if (error.name === 'ZodError') {
        return reply.code(400).send({
          success: false,
          message: '请求数据格式错误',
          errors: error.errors
        });
      } else if (error.message.includes('不存在')) {
        return reply.code(404).send({
          success: false,
          message: error.message
        });
      } else {
        return reply.code(500).send({
          success: false,
          message: '更新操作员失败',
          error: error.message
        });
      }
    }
  });

  // 删除操作员
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      
      // 删除配置
      await configManager.deleteOperatorConfig(id);
      
      // 从引擎中移除操作员
      try {
        await engine.syncRemoveOperator(id);
        fastify.log.info(`📻 [API] 删除操作员: ${id}`);
      } catch (engineError) {
        fastify.log.warn(`📻 [API] 操作员配置已删除，但从引擎移除失败: ${engineError}`);
      }
      
      return reply.code(200).send({
        success: true,
        message: '操作员删除成功'
      });
    } catch (error: any) {
      fastify.log.error('删除操作员失败:', error);
      if (error.message.includes('不存在') || error.message.includes('不能删除')) {
        return reply.code(400).send({
          success: false,
          message: error.message
        });
      } else {
        return reply.code(500).send({
          success: false,
          message: '删除操作员失败',
          error: error.message
        });
      }
    }
  });

  // 启动操作员发射
  fastify.post<{ Params: { id: string } }>('/:id/start', async (request, reply) => {
    try {
      const { id } = request.params;
      
      engine.startOperator(id);
      
      return reply.code(200).send({
        success: true,
        message: '操作员启动成功'
      });
    } catch (error: any) {
      fastify.log.error('启动操作员失败:', error);
      return reply.code(500).send({
        success: false,
        message: '启动操作员失败',
        error: error.message
      });
    }
  });

  // 停止操作员发射
  fastify.post<{ Params: { id: string } }>('/:id/stop', async (request, reply) => {
    try {
      const { id } = request.params;
      
      engine.stopOperator(id);
      
      return reply.code(200).send({
        success: true,
        message: '操作员停止成功'
      });
    } catch (error: any) {
      fastify.log.error('停止操作员失败:', error);
      return reply.code(500).send({
        success: false,
        message: '停止操作员失败',
        error: error.message
      });
    }
  });

  // 获取操作员运行状态
  fastify.get<{ Params: { id: string } }>('/:id/status', async (request, reply) => {
    try {
      const { id } = request.params;
      
      const operatorStatus = engine.getOperatorsStatus().find(op => op.id === id);
      
      if (!operatorStatus) {
        return reply.code(404).send({
          success: false,
          message: `操作员 ${id} 不存在或未启动`
        });
      }
      
      return reply.code(200).send({
        success: true,
        data: operatorStatus
      });
    } catch (error: any) {
      fastify.log.error('获取操作员状态失败:', error);
      return reply.code(500).send({
        success: false,
        message: '获取操作员状态失败',
        error: error.message
      });
    }
  });
} 