/* eslint-disable @typescript-eslint/no-explicit-any */
// 路由处理器 - FastifyRequest/Reply类型需要使用any

/**
 * 操作员管理API路由
 * 权限模型：
 * - 操作员可见性完全由 token.operatorIds 控制
 * - Admin 无限制，能看到和操作所有操作员
 * - 创建操作员时自动加入创建者 token 的 operatorIds
 * - 删除操作员时自动从所有 token 的 operatorIds 中清理
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
  type RadioOperatorConfig,
  UserRole,
} from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';
import { requireRole, requireOperatorAccess } from '../auth/authPlugin.js';
import { AuthManager } from '../auth/AuthManager.js';

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
  const authManager = AuthManager.getInstance();

  // 获取所有操作员配置（按 token.operatorIds 过滤）
  fastify.get('/', async (request, reply) => {
    try {
      const operators = configManager.getOperatorsConfig();
      const authUser = request.authUser;

      // 按权限过滤：Admin 看全部，其他角色只看 operatorIds 中的
      const filtered = (authUser && authUser.role === UserRole.ADMIN)
        ? operators
        : operators.filter(op => authUser?.operatorIds.includes(op.id));

      const response = RadioOperatorListResponseSchema.parse({
        success: true,
        data: filtered
      });

      return reply.code(200).send(response);
    } catch (error: any) {
      fastify.log.error('Failed to get operators list:', error);
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 获取指定操作员配置
  fastify.get<{ Params: { id: string } }>('/:id', {
    preHandler: [requireOperatorAccess((req) => (req.params as any).id)],
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const operator = configManager.getOperatorConfig(id);

      if (!operator) {
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `Operator config does not exist: ${id}`,
          userMessage: `Operator ${id} does not exist`,
          severity: RadioErrorSeverity.WARNING,
          suggestions: [
            'Check if operator ID is correct',
            'Use GET /api/operators to list all operators'
          ],
        });
      }

      const response = RadioOperatorDetailResponseSchema.parse({
        success: true,
        data: operator
      });

      return reply.code(200).send(response);
    } catch (error: any) {
      fastify.log.error('Failed to get operator details:', error);
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 创建新操作员（OPERATOR+ 角色，受 maxOperators 限制）
  fastify.post<{ Body: CreateRadioOperatorRequest }>('/', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (request, reply) => {
    try {
      const authUser = request.authUser!;
      const operatorData = CreateRadioOperatorRequestSchema.parse(request.body);

      // 检查 maxOperators 限制
      if (!authManager.canAddOperator(authUser.tokenId)) {
        const maxOps = authManager.getTokenMaxOperators(authUser.tokenId);
        throw new RadioError({
          code: RadioErrorCode.INVALID_OPERATION,
          message: `Operator count has reached the limit (${maxOps})`,
          userMessage: `Maximum ${maxOps} operators allowed, please delete existing operators first`,
          severity: RadioErrorSeverity.WARNING,
        });
      }

      // 智能分配频率（如果未指定或为0）
      let frequency = operatorData.frequency;
      if (!frequency || frequency === 0) {
        const existingOperators = configManager.getOperatorsConfig();
        frequency = allocateFrequency(existingOperators);
        fastify.log.info(`[API] auto-assigned frequency for new operator: ${frequency} Hz`);
      }

      // 创建操作员配置
      const newOperatorData = {
        ...operatorData,
        createdByTokenId: authUser.tokenId, // 审计字段：记录创建者
        mode: operatorData.mode || MODES.FT8,
        myGrid: operatorData.myGrid || '',
        frequency,
      };

      const newOperator = await configManager.addOperatorConfig(newOperatorData);

      // 自动将新操作员加入创建者 token 的 operatorIds
      await authManager.addOperatorToToken(authUser.tokenId, newOperator.id);

      // 如果引擎正在运行，同步添加到引擎中
      try {
        await engine.operatorManager.syncAddOperator(newOperator);
        fastify.log.info(`[API] operator created: ${newOperator.id} (${newOperator.myCallsign}) by token ${authUser.tokenId}`);
      } catch (engineError) {
        fastify.log.warn(`[API] operator config saved but failed to add to engine: ${engineError}`);
      }

      const response = RadioOperatorActionResponseSchema.parse({
        success: true,
        message: 'Operator created successfully',
        data: newOperator
      });

      return reply.code(201).send(response);
    } catch (error: any) {
      fastify.log.error('Failed to create operator:', error);

      if (error.name === 'ZodError') {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: 'Operator config data format error',
          userMessage: 'Request data format is incorrect',
          severity: RadioErrorSeverity.WARNING,
          suggestions: [
            'Check required fields: myCallsign',
            'Ensure frequency value is in valid range (0-4000 Hz)',
            'Refer to API documentation for example format',
          ],
          context: { errors: error.errors },
        });
      }

      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 更新操作员配置（需要操作员访问权限）
  fastify.put<{ Params: { id: string }; Body: UpdateRadioOperatorRequest }>('/:id', {
    preHandler: [requireRole(UserRole.OPERATOR), requireOperatorAccess((req) => (req.params as any).id)],
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const updates = UpdateRadioOperatorRequestSchema.parse(request.body);

      // 更新配置
      const updatedOperator = await configManager.updateOperatorConfig(id, updates);

      // 同步更新到引擎中
      try {
        await engine.operatorManager.syncUpdateOperator(updatedOperator);
        fastify.log.info(`[API] operator updated: ${id} (${updatedOperator.myCallsign})`);
      } catch (engineError) {
        fastify.log.warn(`[API] operator config updated but failed to sync to engine: ${engineError}`);
      }

      const response = RadioOperatorActionResponseSchema.parse({
        success: true,
        message: 'Operator updated successfully',
        data: updatedOperator
      });

      return reply.code(200).send(response);
    } catch (error: any) {
      fastify.log.error('Failed to update operator:', error);

      if (error.name === 'ZodError') {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: 'Operator update data format error',
          userMessage: 'Request data format is incorrect',
          severity: RadioErrorSeverity.WARNING,
          suggestions: [
            'Check if field types are correct',
            'Ensure frequency value is in valid range (0-4000 Hz)',
            'Refer to API documentation for update example',
          ],
          context: { errors: error.errors },
        });
      } else if (error instanceof Error && error.message.includes('does not exist')) {
        const operatorId = (request.params as any).id;
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `Operator does not exist: ${operatorId}`,
          userMessage: error.message,
          severity: RadioErrorSeverity.WARNING,
          suggestions: [
            'Check if operator ID is correct',
            'Use GET /api/operators to list all operators',
          ],
        });
      }

      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 删除操作员（需要操作员访问权限）
  fastify.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [requireRole(UserRole.OPERATOR), requireOperatorAccess((req) => (req.params as any).id)],
  }, async (request, reply) => {
    try {
      const { id } = request.params;

      // 删除配置
      await configManager.deleteOperatorConfig(id);

      // 从所有 token 的 operatorIds 中移除
      await authManager.removeOperatorFromAllTokens(id);

      // 从引擎中移除操作员
      try {
        await engine.operatorManager.syncRemoveOperator(id);
        fastify.log.info(`[API] operator deleted: ${id}`);
      } catch (engineError) {
        fastify.log.warn(`[API] operator config deleted but failed to remove from engine: ${engineError}`);
      }

      return reply.code(200).send({
        success: true,
        message: 'Operator deleted successfully'
      });
    } catch (error: any) {
      fastify.log.error('Failed to delete operator:', error);

      if (error instanceof Error && error.message.includes('does not exist')) {
        const operatorId = (request.params as any).id;
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `Operator does not exist: ${operatorId}`,
          userMessage: error.message,
          severity: RadioErrorSeverity.WARNING,
          suggestions: [
            'Check if operator ID is correct',
            'Use GET /api/operators to list all operators',
          ],
        });
      } else if (error instanceof Error && error.message.includes('Cannot delete')) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: `Operator deletion restricted: ${error.message}`,
          userMessage: error.message,
          severity: RadioErrorSeverity.WARNING,
          suggestions: [
            'Check if this is the default operator (default operators cannot be deleted)',
            'Ensure operator is not running',
          ],
        });
      }

      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 启动操作员发射（OPERATOR+ 角色 + 操作员访问权限）
  fastify.post<{ Params: { id: string } }>('/:id/start', {
    preHandler: [requireRole(UserRole.OPERATOR), requireOperatorAccess((req) => (req.params as any).id)],
  }, async (request, reply) => {
    try {
      const { id } = request.params;

      engine.operatorManager.startOperator(id);

      return reply.code(200).send({
        success: true,
        message: 'Operator started successfully'
      });
    } catch (error: any) {
      fastify.log.error('Failed to start operator:', error);
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 停止操作员发射（OPERATOR+ 角色 + 操作员访问权限）
  fastify.post<{ Params: { id: string } }>('/:id/stop', {
    preHandler: [requireRole(UserRole.OPERATOR), requireOperatorAccess((req) => (req.params as any).id)],
  }, async (request, reply) => {
    try {
      const { id } = request.params;

      engine.operatorManager.stopOperator(id);

      return reply.code(200).send({
        success: true,
        message: 'Operator stopped successfully'
      });
    } catch (error: any) {
      fastify.log.error('Failed to stop operator:', error);
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 获取操作员运行状态
  fastify.get<{ Params: { id: string } }>('/:id/status', {
    preHandler: [requireOperatorAccess((req) => (req.params as any).id)],
  }, async (request, reply) => {
    try {
      const { id } = request.params;

      const operatorStatus = engine.operatorManager.getOperatorsStatus().find(op => op.id === id);

      if (!operatorStatus) {
        throw new RadioError({
          code: RadioErrorCode.RESOURCE_UNAVAILABLE,
          message: `Operator status unavailable: ${id}`,
          userMessage: `Operator ${id} does not exist or has not started`,
          severity: RadioErrorSeverity.WARNING,
          suggestions: [
            'Check if operator ID is correct',
            'Ensure engine is started',
            'Use POST /api/operators/:id/start to start operator',
          ],
        });
      }

      return reply.code(200).send({
        success: true,
        data: operatorStatus
      });
    } catch (error: any) {
      fastify.log.error('Failed to get operator status:', error);
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
}
