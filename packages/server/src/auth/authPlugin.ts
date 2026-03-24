import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import { UserRole, type JWTPayload } from '@tx5dr/contracts';
import { AuthManager } from './AuthManager.js';
import { normalizeCallsign } from '../utils/callsign.js';

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
        error: { code: 'UNAUTHORIZED', message: 'Authentication required', userMessage: 'Please login first' },
      });
    }
    if (!AuthManager.hasMinRole(request.authUser.role, minRole)) {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Permission denied', userMessage: 'You do not have permission for this operation' },
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
 * 要求对指定日志本有访问权限（基于 operatorId → callsign → logBookId 归属链）
 * 孤儿日志本（无关联操作员）仅 ADMIN 可访问
 */
export function requireLogbookAccess(logManager: import('../log/LogManager.js').LogManager) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.authUser) {
      return reply.code(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required', userMessage: 'Please login first' },
      });
    }

    // ADMIN 直接放行
    if (request.authUser.role === UserRole.ADMIN) return;

    const rawId = (request.params as Record<string, string>).id;
    if (!rawId) return; // 无 id 参数，交由路由处理

    // 解析为真实 logBookId（若日志本尚不存在则放行，由路由层处理）
    const logBookId = logManager.resolveLogBookId(rawId);
    if (!logBookId) return; // 日志本还不存在，放行让路由处理 404 或创建

    // 获取日志本关联的归一化呼号
    const logBookCallsigns = logManager.getCallsignsForLogBook(logBookId);

    // 孤儿日志本（无关联呼号）：仅 ADMIN 可访问，此处直接拒绝
    if (logBookCallsigns.length === 0) {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'No logbook access', userMessage: 'You do not have permission to access this logbook' },
      });
    }

    // 获取用户操作员的归一化呼号集合
    const { ConfigManager } = await import('../config/config-manager.js');
    const operatorsConfig = ConfigManager.getInstance().getOperatorsConfig();
    const userCallsigns = new Set<string>();
    for (const op of operatorsConfig) {
      if (request.authUser.operatorIds.includes(op.id)) {
        userCallsigns.add(normalizeCallsign(op.myCallsign));
      }
    }

    // 检查用户呼号与日志本呼号是否有交集
    const hasAccess = logBookCallsigns.some(cs => userCallsigns.has(cs));
    if (!hasAccess) {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'No logbook access', userMessage: 'You do not have permission to access this logbook' },
      });
    }
  };
}

/**
 * 呼号级别的访问控制中间件
 * ADMIN 可以访问任何呼号的同步配置
 * OPERATOR 只能访问自己操作员关联的呼号
 */
export function requireCallsignAccess() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.authUser) {
      return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    }
    if (request.authUser.role === UserRole.ADMIN) return; // admin 放行

    const rawCallsign = (request.params as Record<string, string>).callsign;
    if (!rawCallsign) return; // 无参数，放行（由路由处理）

    // 归一化请求的呼号
    const targetBase = normalizeCallsign(rawCallsign);

    // 检查用户的操作员是否有该呼号
    const { ConfigManager } = await import('../config/config-manager.js');
    const configManager = ConfigManager.getInstance();
    const operatorsConfig = configManager.getOperatorsConfig();
    const userOperatorCallsigns = new Set<string>();
    for (const op of operatorsConfig) {
      if (request.authUser.operatorIds.includes(op.id)) {
        userOperatorCallsigns.add(normalizeCallsign(op.myCallsign));
      }
    }

    if (!userOperatorCallsigns.has(targetBase)) {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'No permission to access sync config for this callsign' },
      });
    }
  };
}

// normalizeCallsign 已迁移到 ../utils/callsign.ts 共享模块

/**
 * 要求对指定操作员有访问权限
 */
export function requireOperatorAccess(getOperatorId: (request: FastifyRequest) => string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.authUser) {
      return reply.code(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required', userMessage: 'Please login first' },
      });
    }
    const operatorId = getOperatorId(request);
    if (!AuthManager.hasOperatorAccess(request.authUser.role, request.authUser.operatorIds, operatorId)) {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'No operator access', userMessage: 'You do not have access to this operator' },
      });
    }
  };
}
