import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import { UserRole, type JWTPayload } from '@tx5dr/contracts';
import { AuthManager } from './AuthManager.js';

// 扩展 Fastify Request 类型
declare module 'fastify' {
  interface FastifyRequest {
    authUser: JWTPayload | null;
  }
}

// 使用 fastify-plugin 包装，避免 Fastify 作用域封装
// 这样 @fastify/jwt 的 jwtSign/jwtVerify 在所有路由中可用
export const authPlugin = fp(async function authPluginInner(fastify: FastifyInstance): Promise<void> {
  const authManager = AuthManager.getInstance();

  // 注册 JWT 插件
  await fastify.register(fastifyJwt, {
    secret: authManager.getJwtSecret(),
    sign: {
      expiresIn: authManager.getJwtExpiresIn(),
    },
  });

  // 装饰 request，添加 authUser
  fastify.decorateRequest('authUser', null);

  // 全局 onRequest hook：提取并验证 JWT
  fastify.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    request.authUser = null;

    if (!authManager.isAuthEnabled()) {
      // 认证未启用 → 所有请求视为 Admin（向后兼容）
      request.authUser = {
        tokenId: '__local__',
        role: UserRole.ADMIN,
        operatorIds: [],
        iat: 0,
        exp: 0,
      };
      return;
    }

    // 跳过不需认证的路由
    const skipPaths = ['/api/auth/login', '/api/auth/status'];
    if (skipPaths.includes(request.url) || request.url === '/' || request.url === '/api/hello') {
      return;
    }

    // 尝试从 Authorization header 提取 JWT
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return; // 无 token，authUser 保持 null
    }

    try {
      const decoded = await request.jwtVerify<JWTPayload>();

      // 检查引用的 token 是否仍有效（未被撤销/过期）
      if (!authManager.isTokenStillValid(decoded.tokenId)) {
        request.authUser = null;
        return;
      }

      // 使用 token 的最新权限（管理员可能已更新该 token 的角色/操作员）
      const current = authManager.getTokenCurrentPermissions(decoded.tokenId);
      if (current) {
        request.authUser = {
          ...decoded,
          role: current.role,
          operatorIds: current.operatorIds,
        };
      }
    } catch {
      // JWT 无效或过期
      request.authUser = null;
    }
  });
});

// ===== 权限检查辅助函数 =====

/**
 * 要求最低角色等级
 */
export function requireRole(minRole: UserRole) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.authUser) {
      return reply.code(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: '需要认证', userMessage: '请先登录' },
      });
    }
    if (!AuthManager.hasMinRole(request.authUser.role, minRole)) {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: '权限不足', userMessage: '您没有执行此操作的权限' },
      });
    }
  };
}

/**
 * 创建一个 Fastify 插件，为注册范围内所有路由添加最低角色要求
 */
export function withRole(minRole: UserRole) {
  return async (fastify: FastifyInstance) => {
    fastify.addHook('onRequest', requireRole(minRole));
  };
}

/**
 * 要求对指定操作员有访问权限
 */
export function requireOperatorAccess(getOperatorId: (request: FastifyRequest) => string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.authUser) {
      return reply.code(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: '需要认证', userMessage: '请先登录' },
      });
    }
    const operatorId = getOperatorId(request);
    if (!AuthManager.hasOperatorAccess(request.authUser.role, request.authUser.operatorIds, operatorId)) {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: '无操作员访问权限', userMessage: '您没有该操作员的访问权限' },
      });
    }
  };
}
