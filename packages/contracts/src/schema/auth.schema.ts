import { z } from 'zod';
import { PermissionGrantSchema } from './ability.js';

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
  tokenPlain: z.string().optional(), // plaintext stored so admins can retrieve it later
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
  permissionGrants: z.array(PermissionGrantSchema).optional(), // CASL permission grants
  allowSelfLoginCredential: z.boolean().optional(),
  loginCredential: z.object({
    username: z.string(),
    usernameNormalized: z.string(),
    passwordHash: z.string(),
    updatedAt: z.number(),
  }).optional(),
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

export const PasswordLoginRequestSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(1),
});

export type PasswordLoginRequest = z.infer<typeof PasswordLoginRequestSchema>;

export const LoginResponseSchema = z.object({
  jwt: z.string(),
  role: z.nativeEnum(UserRole),
  label: z.string(),
  operatorIds: z.array(z.string()),
  maxOperators: z.number().optional(),
  permissionGrants: z.array(PermissionGrantSchema).optional(),
});

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const BrowserLoginCodeResponseSchema = z.object({
  code: z.string().min(1),
  expiresAt: z.number(),
});

export type BrowserLoginCodeResponse = z.infer<typeof BrowserLoginCodeResponseSchema>;

export const ExchangeBrowserLoginCodeRequestSchema = z.object({
  code: z.string().min(1),
});

export type ExchangeBrowserLoginCodeRequest = z.infer<typeof ExchangeBrowserLoginCodeRequestSchema>;

// ===== Token 管理（Admin API） =====

export const LoginCredentialSummarySchema = z.object({
  username: z.string(),
  allowSelfService: z.boolean(),
});

export type LoginCredentialSummary = z.infer<typeof LoginCredentialSummarySchema>;

export const AuthMeLoginCredentialSchema = z.object({
  configured: z.boolean(),
  username: z.string().nullable(),
  allowSelfService: z.boolean(),
});

export type AuthMeLoginCredential = z.infer<typeof AuthMeLoginCredentialSchema>;

export const CreateTokenLoginCredentialRequestSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9._-]+$/),
  password: z.string().min(8).max(128),
});

export type CreateTokenLoginCredentialRequest = z.infer<typeof CreateTokenLoginCredentialRequestSchema>;

export const UpdateTokenLoginCredentialRequestSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9._-]+$/),
  password: z.string().min(8).max(128).optional(),
});

export type UpdateTokenLoginCredentialRequest = z.infer<typeof UpdateTokenLoginCredentialRequestSchema>;

export const CreateTokenRequestSchema = z.object({
  label: z.string().min(1).max(100),
  role: z.nativeEnum(UserRole),
  operatorIds: z.array(z.string()),
  expiresAt: z.number().optional(),
  maxOperators: z.number().min(0), // 必选，0 表示不限制
  permissionGrants: z.array(PermissionGrantSchema).optional(),
  allowSelfLoginCredential: z.boolean().optional(),
  loginCredential: CreateTokenLoginCredentialRequestSchema.optional(),
});

export type CreateTokenRequest = z.infer<typeof CreateTokenRequestSchema>;

export const CreateTokenResponseSchema = z.object({
  id: z.string(),
  token: z.string(),
  label: z.string(),
  role: z.nativeEnum(UserRole),
  operatorIds: z.array(z.string()),
  maxOperators: z.number().optional(),
  permissionGrants: z.array(PermissionGrantSchema).optional(),
  allowSelfLoginCredential: z.boolean().optional(),
  loginCredential: LoginCredentialSummarySchema.optional(),
});

export type CreateTokenResponse = z.infer<typeof CreateTokenResponseSchema>;

export const TokenInfoSchema = z.object({
  id: z.string(),
  token: z.string().optional(), // plaintext token value (admin only)
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
  permissionGrants: z.array(PermissionGrantSchema).optional(),
  allowSelfLoginCredential: z.boolean().optional(),
  loginCredential: LoginCredentialSummarySchema.optional(),
});

export type TokenInfo = z.infer<typeof TokenInfoSchema>;

export const UpdateTokenRequestSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  role: z.nativeEnum(UserRole).optional(),
  operatorIds: z.array(z.string()).optional(),
  expiresAt: z.number().nullable().optional(),
  maxOperators: z.number().min(0).nullable().optional(), // null 表示移除限制
  permissionGrants: z.array(PermissionGrantSchema).nullable().optional(), // null to clear
  allowSelfLoginCredential: z.boolean().optional(),
  loginCredential: UpdateTokenLoginCredentialRequestSchema.nullable().optional(),
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
  permissionGrants: z.array(PermissionGrantSchema).optional(),
  loginCredential: AuthMeLoginCredentialSchema,
});

export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>;

export const UpdateSelfLoginCredentialRequestSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9._-]+$/),
  password: z.string().min(8).max(128).optional(),
});

export type UpdateSelfLoginCredentialRequest = z.infer<typeof UpdateSelfLoginCredentialRequestSchema>;

// ===== 更新认证配置请求（PATCH /api/auth/config） =====

export const UpdateAuthConfigRequestSchema = z.object({
  allowPublicViewing: z.boolean().optional(),
});

export type UpdateAuthConfigRequest = z.infer<typeof UpdateAuthConfigRequestSchema>;

export const RemoteAccessPresetSchema = z.enum(['local', 'lan', 'public']);
export type RemoteAccessPreset = z.infer<typeof RemoteAccessPresetSchema>;

export function isPrivateRemoteAccessHostname(hostname: string): boolean {
  if (['localhost', '127.0.0.1', '::1'].includes(hostname)) return true;
  if (hostname.includes(':')) {
    const normalized = hostname.toLowerCase();
    return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8')
      || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || (parts[0] === 169 && parts[1] === 254);
}

export function normalizeRemoteAccessOrigin(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isSecureRemoteAccessOrigin(value: string): boolean {
  const normalized = normalizeRemoteAccessOrigin(value);
  if (!normalized) return false;
  const parsed = new URL(normalized);
  return parsed.protocol === 'https:' || isPrivateRemoteAccessHostname(parsed.hostname);
}

export const RemoteAccessSecurityConfigSchema = z.object({
  preset: RemoteAccessPresetSchema.default('lan'),
  allowedOrigins: z.array(z.string().url().refine(
    value => normalizeRemoteAccessOrigin(value) !== null,
    'Expected a complete HTTP(S) origin without a path',
  )).max(32).default([]),
  maxConnections: z.number().int().min(1).max(512).default(32),
  maxConnectionsPerIp: z.number().int().min(1).max(128).default(16),
  maxPendingAuth: z.number().int().min(1).max(128).default(32),
  authTimeoutMs: z.number().int().min(3_000).max(60_000).default(10_000),
  handshakeTimeoutMs: z.number().int().min(3_000).max(60_000).default(10_000),
});
export type RemoteAccessSecurityConfig = z.infer<typeof RemoteAccessSecurityConfigSchema>;

export const UpdateRemoteAccessSecurityRequestSchema = RemoteAccessSecurityConfigSchema.partial().extend({
  allowPublicViewing: z.boolean().optional(),
});
export type UpdateRemoteAccessSecurityRequest = z.infer<typeof UpdateRemoteAccessSecurityRequestSchema>;

export const RemoteAccessSecurityStatusSchema = RemoteAccessSecurityConfigSchema.extend({
  allowPublicViewing: z.boolean(),
  activeConnections: z.number().int().nonnegative(),
  pendingConnections: z.number().int().nonnegative(),
});
export type RemoteAccessSecurityStatus = z.infer<typeof RemoteAccessSecurityStatusSchema>;

// ===== 认证配置（持久化到 auth.json） =====

export const AuthConfigSchema = z.object({
  enabled: z.boolean().default(true),
  // Existing installations persist their explicit value; new installations opt in.
  allowPublicViewing: z.boolean().default(false),
  remoteAccess: RemoteAccessSecurityConfigSchema.default({}),
  jwtSecret: z.string().optional(),
  jwtExpiresInSeconds: z.number().default(7 * 24 * 3600), // 7 days
  tokens: z.array(AuthTokenSchema).default([]),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;
