import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  LoginRequestSchema,
  CreateTokenRequestSchema,
  UpdateTokenRequestSchema,
  UpdateAuthConfigRequestSchema,
  UserRole,
} from '@tx5dr/contracts';
import { AuthManager } from '../auth/AuthManager.js';
import { requireRole } from '../auth/authPlugin.js';

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const authManager = AuthManager.getInstance();

  // GET /api/auth/status — 公开，返回认证模式信息
  fastify.get('/status', async () => {
    return authManager.getAuthConfig();
  });

  // POST /api/auth/login — 公开，Token 登录
  fastify.post('/login', async (request, reply) => {
    const body = LoginRequestSchema.parse(request.body);
    const authToken = await authManager.validateToken(body.token);

    if (!authToken) {
      return reply.code(401).send({
        success: false,
        error: { code: 'INVALID_TOKEN', message: '令牌无效或已过期', userMessage: '令牌无效或已过期' },
      });
    }

    const jwt = await reply.jwtSign({
      tokenId: authToken.id,
      role: authToken.role,
      operatorIds: authToken.operatorIds,
    });

    return {
      jwt,
      role: authToken.role,
      label: authToken.label,
      operatorIds: authToken.operatorIds,
      maxOperators: authToken.maxOperators,
    };
  });

  // GET /api/auth/me — 已认证用户获取自身信息
  fastify.get('/me', async (request, reply) => {
    if (!request.authUser) {
      return reply.code(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: '未认证', userMessage: '请先登录' },
      });
    }

    const tokenInfo = authManager.getTokenById(request.authUser.tokenId);
    return {
      role: request.authUser.role,
      label: tokenInfo?.label || '',
      operatorIds: request.authUser.operatorIds,
      tokenId: request.authUser.tokenId,
      maxOperators: tokenInfo?.maxOperators,
    };
  });

  // PATCH /api/auth/config — Admin 更新认证配置
  fastify.patch('/config', {
    preHandler: [requireRole(UserRole.ADMIN)],
  }, async (request) => {
    const body = UpdateAuthConfigRequestSchema.parse(request.body);
    return authManager.updateAuthConfig(body);
  });

  // GET /api/auth/tokens — Admin 列出所有 Token
  fastify.get('/tokens', {
    preHandler: [requireRole(UserRole.ADMIN)],
  }, async () => {
    return authManager.listTokens();
  });

  // POST /api/auth/tokens — Admin 创建新 Token
  fastify.post('/tokens', {
    preHandler: [requireRole(UserRole.ADMIN)],
  }, async (request) => {
    const body = CreateTokenRequestSchema.parse(request.body);
    const createdBy = (request as FastifyRequest).authUser?.tokenId ?? null;
    return authManager.createToken(body, createdBy);
  });

  // PATCH /api/auth/tokens/:id — Admin 更新 Token
  fastify.patch<{ Params: { id: string } }>('/tokens/:id', {
    preHandler: [requireRole(UserRole.ADMIN)],
  }, async (request, reply) => {
    const { id } = request.params;
    const body = UpdateTokenRequestSchema.parse(request.body);
    const result = await authManager.updateToken(id, body);

    if (!result) {
      return reply.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: '令牌不存在', userMessage: '令牌不存在' },
      });
    }

    return result;
  });

  // DELETE /api/auth/tokens/:id — Admin 撤销 Token
  fastify.delete<{ Params: { id: string } }>('/tokens/:id', {
    preHandler: [requireRole(UserRole.ADMIN)],
  }, async (request, reply) => {
    const { id } = request.params;
    const result = await authManager.revokeToken(id);

    if (!result.success) {
      if (result.error === 'SYSTEM_TOKEN') {
        return reply.code(403).send({
          success: false,
          error: { code: 'SYSTEM_TOKEN', message: '系统令牌不可撤销', userMessage: '系统令牌不可撤销，请使用"重新生成"功能' },
        });
      }
      return reply.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: '令牌不存在', userMessage: '令牌不存在' },
      });
    }

    return { success: true };
  });

  // POST /api/auth/tokens/:id/regenerate — Admin 重新生成系统令牌
  fastify.post<{ Params: { id: string } }>('/tokens/:id/regenerate', {
    preHandler: [requireRole(UserRole.ADMIN)],
  }, async (request, reply) => {
    const { id } = request.params;
    const result = await authManager.regenerateSystemToken(id);

    if (!result) {
      return reply.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: '令牌不存在或非系统令牌', userMessage: '令牌不存在或非系统令牌' },
      });
    }

    return result;
  });
}
