import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  LoginRequestSchema,
  PasswordLoginRequestSchema,
  CreateTokenRequestSchema,
  UpdateTokenRequestSchema,
  UpdateSelfLoginCredentialRequestSchema,
  UpdateAuthConfigRequestSchema,
  UserRole,
} from '@tx5dr/contracts';
import { AuthManager, AuthManagerError } from '../auth/AuthManager.js';
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
        error: { code: 'INVALID_TOKEN', message: 'Token is invalid or expired', userMessage: 'Token is invalid or expired' },
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
      permissionGrants: authToken.permissionGrants,
    };
  });

  // POST /api/auth/login-password — 公开，用户名密码登录
  fastify.post('/login-password', async (request, reply) => {
    const body = PasswordLoginRequestSchema.parse(request.body);
    const authToken = await authManager.validatePasswordLogin(body.username, body.password);

    if (!authToken) {
      return reply.code(401).send({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Username or password is incorrect', userMessage: 'Username or password is incorrect' },
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
      permissionGrants: authToken.permissionGrants,
    };
  });

  // GET /api/auth/me — 已认证用户获取自身信息
  fastify.get('/me', async (request, reply) => {
    if (!request.authUser) {
      return reply.code(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated', userMessage: 'Please login first' },
      });
    }

    const tokenInfo = authManager.getTokenById(request.authUser.tokenId);
    return {
      role: request.authUser.role,
      label: tokenInfo?.label || '',
      operatorIds: request.authUser.operatorIds,
      tokenId: request.authUser.tokenId,
      maxOperators: tokenInfo?.maxOperators,
      permissionGrants: tokenInfo?.permissionGrants,
      loginCredential: authManager.getAuthMeLoginCredential(request.authUser.tokenId),
    };
  });

  // PUT /api/auth/me/login-credential — 当前用户设置/修改用户名密码登录
  fastify.put('/me/login-credential', async (request, reply) => {
    if (!request.authUser) {
      return reply.code(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated', userMessage: 'Please login first' },
      });
    }

    const body = UpdateSelfLoginCredentialRequestSchema.parse(request.body);
    const result = await authManager.updateSelfLoginCredential(request.authUser.tokenId, body);

    if (result.error) {
      if (result.error === 'SELF_SERVICE_DISABLED') {
        return reply.code(403).send({
          success: false,
          error: { code: 'SELF_SERVICE_DISABLED', message: 'Self-service login credential management is disabled', userMessage: 'This token is not allowed to manage its own username and password' },
        });
      }
      if (result.error === 'USERNAME_TAKEN') {
        return reply.code(409).send({
          success: false,
          error: { code: 'USERNAME_TAKEN', message: 'Username is already in use', userMessage: 'This username is already in use' },
        });
      }
      if (result.error === 'PASSWORD_REQUIRED') {
        return reply.code(400).send({
          success: false,
          error: { code: 'PASSWORD_REQUIRED', message: 'Password is required when setting login credentials for the first time', userMessage: 'Please set a password when enabling username/password login for the first time' },
        });
      }
    }

    const tokenInfo = result.tokenInfo!;
    return {
      role: request.authUser.role,
      label: tokenInfo.label,
      operatorIds: request.authUser.operatorIds,
      tokenId: request.authUser.tokenId,
      maxOperators: tokenInfo.maxOperators,
      permissionGrants: tokenInfo.permissionGrants,
      loginCredential: authManager.getAuthMeLoginCredential(request.authUser.tokenId),
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
  }, async (request, reply) => {
    const body = CreateTokenRequestSchema.parse(request.body);
    const createdBy = (request as FastifyRequest).authUser?.tokenId ?? null;

    try {
      return await authManager.createToken(body, createdBy);
    } catch (error) {
      if (error instanceof AuthManagerError) {
        if (error.code === 'USERNAME_TAKEN') {
          return reply.code(409).send({
            success: false,
            error: { code: 'USERNAME_TAKEN', message: 'Username is already in use', userMessage: 'This username is already in use' },
          });
        }
      }
      throw error;
    }
  });

  // PATCH /api/auth/tokens/:id — Admin 更新 Token
  fastify.patch<{ Params: { id: string } }>('/tokens/:id', {
    preHandler: [requireRole(UserRole.ADMIN)],
  }, async (request, reply) => {
    const { id } = request.params;
    const body = UpdateTokenRequestSchema.parse(request.body);
    let result;
    try {
      result = await authManager.updateToken(id, body);
    } catch (error) {
      if (error instanceof AuthManagerError) {
        if (error.code === 'USERNAME_TAKEN') {
          return reply.code(409).send({
            success: false,
            error: { code: 'USERNAME_TAKEN', message: 'Username is already in use', userMessage: 'This username is already in use' },
          });
        }
        if (error.code === 'PASSWORD_REQUIRED') {
          return reply.code(400).send({
            success: false,
            error: { code: 'PASSWORD_REQUIRED', message: 'Password is required when setting login credentials for the first time', userMessage: 'Please set a password when enabling username/password login for the first time' },
          });
        }
      }
      throw error;
    }

    if (!result) {
      return reply.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Token does not exist', userMessage: 'Token does not exist' },
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
          error: { code: 'SYSTEM_TOKEN', message: 'System token cannot be revoked', userMessage: 'System token cannot be revoked, use regenerate instead' },
        });
      }
      return reply.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Token does not exist', userMessage: 'Token does not exist' },
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
        error: { code: 'NOT_FOUND', message: 'Token does not exist or is not a system token', userMessage: 'Token does not exist or is not a system token' },
      });
    }

    return result;
  });
}
