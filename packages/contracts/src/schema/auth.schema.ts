import { z } from 'zod';

// ===== 角色枚举 =====

export enum UserRole {
  VIEWER = 'viewer',
  OPERATOR = 'operator',
  ADMIN = 'admin',
}

/** 角色权限等级（用于比较） */
export const USER_ROLE_LEVEL: Record<UserRole, number> = {
  [UserRole.VIEWER]: 0,
  [UserRole.OPERATOR]: 1,
  [UserRole.ADMIN]: 2,
};

// ===== Token 数据结构（持久化） =====

export const AuthTokenSchema = z.object({
  id: z.string(),
  tokenHash: z.string(),
  label: z.string(),
  role: z.nativeEnum(UserRole),
  operatorIds: z.array(z.string()),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
  expiresAt: z.number().optional(),
  lastUsedAt: z.number().optional(),
  revoked: z.boolean(),
  system: z.boolean().optional(),
  maxOperators: z.number().min(0).optional(), // 该 Token 可创建的操作员上限
});

export type AuthToken = z.infer<typeof AuthTokenSchema>;

// ===== JWT Payload =====

export const JWTPayloadSchema = z.object({
  tokenId: z.string(),
  role: z.nativeEnum(UserRole),
  operatorIds: z.array(z.string()),
  iat: z.number(),
  exp: z.number(),
});

export type JWTPayload = z.infer<typeof JWTPayloadSchema>;

// ===== 登录请求/响应 =====

export const LoginRequestSchema = z.object({
  token: z.string().min(1),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  jwt: z.string(),
  role: z.nativeEnum(UserRole),
  label: z.string(),
  operatorIds: z.array(z.string()),
  maxOperators: z.number().optional(),
});

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// ===== Token 管理（Admin API） =====

export const CreateTokenRequestSchema = z.object({
  label: z.string().min(1).max(100),
  role: z.nativeEnum(UserRole),
  operatorIds: z.array(z.string()),
  expiresAt: z.number().optional(),
  maxOperators: z.number().min(0), // 必选，0 表示不限制
});

export type CreateTokenRequest = z.infer<typeof CreateTokenRequestSchema>;

export const CreateTokenResponseSchema = z.object({
  id: z.string(),
  token: z.string(),
  label: z.string(),
  role: z.nativeEnum(UserRole),
  operatorIds: z.array(z.string()),
  maxOperators: z.number().optional(),
});

export type CreateTokenResponse = z.infer<typeof CreateTokenResponseSchema>;

export const TokenInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  role: z.nativeEnum(UserRole),
  operatorIds: z.array(z.string()),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
  expiresAt: z.number().optional(),
  lastUsedAt: z.number().optional(),
  revoked: z.boolean(),
  system: z.boolean().optional(),
  maxOperators: z.number().optional(),
});

export type TokenInfo = z.infer<typeof TokenInfoSchema>;

export const UpdateTokenRequestSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  role: z.nativeEnum(UserRole).optional(),
  operatorIds: z.array(z.string()).optional(),
  expiresAt: z.number().nullable().optional(),
  maxOperators: z.number().min(0).nullable().optional(), // null 表示移除限制
});

export type UpdateTokenRequest = z.infer<typeof UpdateTokenRequestSchema>;

// ===== 认证状态（GET /api/auth/status） =====

export const AuthStatusSchema = z.object({
  enabled: z.boolean(),
  allowPublicViewing: z.boolean(),
});

export type AuthStatus = z.infer<typeof AuthStatusSchema>;

// ===== 当前用户信息（GET /api/auth/me） =====

export const AuthMeResponseSchema = z.object({
  role: z.nativeEnum(UserRole),
  label: z.string(),
  operatorIds: z.array(z.string()),
  tokenId: z.string(),
  maxOperators: z.number().optional(),
});

export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>;

// ===== 更新认证配置请求（PATCH /api/auth/config） =====

export const UpdateAuthConfigRequestSchema = z.object({
  allowPublicViewing: z.boolean().optional(),
});

export type UpdateAuthConfigRequest = z.infer<typeof UpdateAuthConfigRequestSchema>;

// ===== 认证配置（持久化到 auth.json） =====

export const AuthConfigSchema = z.object({
  enabled: z.boolean().default(true),
  allowPublicViewing: z.boolean().default(true),
  jwtSecret: z.string().optional(),
  jwtExpiresInSeconds: z.number().default(7 * 24 * 3600), // 7 days
  tokens: z.array(AuthTokenSchema).default([]),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;
