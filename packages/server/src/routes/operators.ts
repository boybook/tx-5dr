/* eslint-disable @typescript-eslint/no-explicit-any */
// 路由处理器 - FastifyRequest/Reply类型需要使用any

/**
 * 操作员管理API路由
 * 📊 Day14优化：统一错误处理，使用 RadioError + Fastify 全局错误处理器
 */
import { FastifyInstance } from 'fastify';
import { ConfigManager } from '../config/config-manager.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import {
  RadioOperatorListResponseSchema,
  RadioOperatorDetailResponseSchema,
  RadioOperatorActionResponseSchema,
  CreateRadioOperatorRequestSchema,
  UpdateRadioOperatorRequestSchema,
  type CreateRadioOperatorRequest,
  type UpdateRadioOperatorRequest,
  type RadioOperatorConfig
} from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';

/**
 * 智能分配音频频率
 * 为新操作员分配一个未被占用的频率，避免与现有操作员冲突
 * @param existingOperators 现有操作员列表
 * @returns 分配的频率（Hz）
 */
function allocateFrequency(existingOperators: RadioOperatorConfig[]): number {
  const BASE_FREQ = 1000; // 起始频率 1000 Hz
  const STEP = 300;       // 间隔 300 Hz（避免相邻频率干扰）
  const MAX_OPERATORS = 10; // 最多支持10个操作员

  // 获取所有已使用的频率
  const usedFrequencies = existingOperators
    .map(op => op.frequency)
    .filter((f): f is number => f !== undefined && f > 0)
    .sort((a, b) => a - b);

  // 尝试分配频率：1000, 1300, 1600, 1900, 2200, 2500, 2800, 3100, 3400, 3700
  for (let i = 0; i < MAX_OPERATORS; i++) {
    const candidate = BASE_FREQ + (i * STEP);
    if (!usedFrequencies.includes(candidate)) {
      return candidate;
    }
  }

  // 如果所有预设频率都被占用，返回一个随机频率（降级策略）
  return BASE_FREQ + Math.floor(Math.random() * 2000);
}

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
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 获取指定操作员配置
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const operator = configManager.getOperatorConfig(id);

      if (!operator) {
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `操作员配置不存在: ${id}`,
          userMessage: `操作员 ${id} 不存在`,
          severity: RadioErrorSeverity.WARNING,
          suggestions: [
            '检查操作员ID是否正确',
            '使用 GET /api/operators 获取所有操作员列表'
          ],
        });
      }

      const response = RadioOperatorDetailResponseSchema.parse({
        success: true,
        data: operator
      });

      return reply.code(200).send(response);
    } catch (error: any) {
      fastify.log.error('获取操作员详情失败:', error);
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
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

      // 移除呼号重复检查 - 支持相同呼号的多操作员
      // 相同呼号的多操作员会共享同一个通联日志本

      // 智能分配频率（如果未指定或为0）
      let frequency = operatorData.frequency;
      if (!frequency || frequency === 0) {
        const existingOperators = configManager.getOperatorsConfig();
        frequency = allocateFrequency(existingOperators);
        fastify.log.info(`📻 [API] 为新操作员自动分配频率: ${frequency} Hz`);
      }

      // 创建操作员配置，确保所有必需字段都存在
      const newOperatorData = {
        ...operatorData,
        mode: operatorData.mode || MODES.FT8,
        myGrid: operatorData.myGrid || '',  // 确保myGrid不为undefined
        frequency,  // 使用分配的频率
      };

      const newOperator = await configManager.addOperatorConfig(newOperatorData);

      // 如果引擎正在运行，同步添加到引擎中
      try {
        await engine.operatorManager.syncAddOperator(newOperator);
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
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: '操作员配置数据格式错误',
          userMessage: '请求数据格式不正确',
          severity: RadioErrorSeverity.WARNING,
          suggestions: [
            '检查必填字段: myCallsign',
            '确保频率值在有效范围内 (0-4000 Hz)',
            '参考 API 文档中的示例格式',
          ],
          context: { errors: error.errors },
        });
      }

      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
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

      // 移除呼号冲突检查 - 支持相同呼号的多操作员
      // 相同呼号的多操作员会共享同一个通联日志本

      // 更新配置
      const updatedOperator = await configManager.updateOperatorConfig(id, updates);

      // 同步更新到引擎中
      try {
        await engine.operatorManager.syncUpdateOperator(updatedOperator);
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
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: '操作员更新数据格式错误',
          userMessage: '请求数据格式不正确',
          severity: RadioErrorSeverity.WARNING,
          suggestions: [
            '检查字段类型是否正确',
            '确保频率值在有效范围内 (0-4000 Hz)',
            '参考 API 文档中的更新示例',
          ],
          context: { errors: error.errors },
        });
      } else if (error instanceof Error && error.message.includes('不存在')) {
        const operatorId = (request.params as any).id;
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `操作员不存在: ${operatorId}`,
          userMessage: error.message,
          severity: RadioErrorSeverity.WARNING,
          suggestions: [
            '检查操作员ID是否正确',
            '使用 GET /api/operators 获取所有操作员列表',
          ],
        });
      }

      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
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
        await engine.operatorManager.syncRemoveOperator(id);
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

      if (error instanceof Error && error.message.includes('不存在')) {
        const operatorId = (request.params as any).id;
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `操作员不存在: ${operatorId}`,
          userMessage: error.message,
          severity: RadioErrorSeverity.WARNING,
          suggestions: [
            '检查操作员ID是否正确',
            '使用 GET /api/operators 获取所有操作员列表',
          ],
        });
      } else if (error instanceof Error && error.message.includes('不能删除')) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: `操作员删除受限: ${error.message}`,
          userMessage: error.message,
          severity: RadioErrorSeverity.WARNING,
          suggestions: [
            '检查是否为默认操作员（默认操作员不能删除）',
            '确保操作员未在运行中',
          ],
        });
      }

      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 启动操作员发射
  fastify.post<{ Params: { id: string } }>('/:id/start', async (request, reply) => {
    try {
      const { id } = request.params;

      engine.operatorManager.startOperator(id);

      return reply.code(200).send({
        success: true,
        message: '操作员启动成功'
      });
    } catch (error: any) {
      fastify.log.error('启动操作员失败:', error);
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 停止操作员发射
  fastify.post<{ Params: { id: string } }>('/:id/stop', async (request, reply) => {
    try {
      const { id } = request.params;

      engine.operatorManager.stopOperator(id);

      return reply.code(200).send({
        success: true,
        message: '操作员停止成功'
      });
    } catch (error: any) {
      fastify.log.error('停止操作员失败:', error);
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 获取操作员运行状态
  fastify.get<{ Params: { id: string } }>('/:id/status', async (request, reply) => {
    try {
      const { id } = request.params;

      const operatorStatus = engine.operatorManager.getOperatorsStatus().find(op => op.id === id);

      if (!operatorStatus) {
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `操作员状态不可用: ${id}`,
          userMessage: `操作员 ${id} 不存在或未启动`,
          severity: RadioErrorSeverity.WARNING,
          suggestions: [
            '检查操作员ID是否正确',
            '确保引擎已启动',
            '使用 POST /api/operators/:id/start 启动操作员',
          ],
        });
      }

      return reply.code(200).send({
        success: true,
        data: operatorStatus
      });
    } catch (error: any) {
      fastify.log.error('获取操作员状态失败:', error);
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
} 