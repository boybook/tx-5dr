import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import {
  type AuthConfig,
  type AuthToken,
  type TokenInfo,
  type CreateTokenRequest,
  type CreateTokenResponse,
  type JWTPayload,
  type UpdateTokenRequest,
  type UpdateAuthConfigRequest,
  UserRole,
  USER_ROLE_LEVEL,
  AuthConfigSchema,
} from '@tx5dr/contracts';
import { getConfigFilePath } from '../utils/app-paths.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AuthManager');

const BCRYPT_ROUNDS = 10;
const TOKEN_PREFIX = 'txdr_';
const TOKEN_BYTES = 32;

export class AuthManager {
  private static instance: AuthManager;
  private config!: AuthConfig;
  private configPath!: string;
  private jwtSecret!: string;

  private constructor() {}

  static getInstance(): AuthManager {
    if (!AuthManager.instance) {
      AuthManager.instance = new AuthManager();
    }
    return AuthManager.instance;
  }

  private adminTokenFilePath!: string;

  async initialize(): Promise<void> {
    this.configPath = await getConfigFilePath('auth.json');
    this.adminTokenFilePath = await getConfigFilePath('.admin-token');
    await this.loadConfig();
    this.ensureJwtSecret();
    await this.ensureInitialAdminToken();
  }

  // ===== 配置持久化 =====

  private async loadConfig(): Promise<void> {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(data);
      this.config = AuthConfigSchema.parse(parsed);
    } catch {
      this.config = AuthConfigSchema.parse({});
      await this.saveConfig();
      logger.info('Default auth config created');
    }
  }

  private async saveConfig(): Promise<void> {
    await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  private ensureJwtSecret(): void {
    if (!this.config.jwtSecret) {
      this.config.jwtSecret = randomBytes(64).toString('hex');
      this.saveConfig().catch(err =>
        logger.error('Failed to save JWT secret:', err)
      );
    }
    this.jwtSecret = this.config.jwtSecret;
  }

  // ===== 初始 Admin Token =====

  private async ensureInitialAdminToken(): Promise<void> {
    // 尝试从 .admin-token 文件读取明文 token
    let plainToken: string | null = null;
    try {
      const content = await fs.readFile(this.adminTokenFilePath, 'utf-8');
      const trimmed = content.trim();
      if (trimmed) plainToken = trimmed;
    } catch {
      // 文件不存在，稍后生成
    }

    if (plainToken) {
      // 文件中有 token，检查是否已注册到 auth.json
      const existing = await this.findTokenByPlainText(plainToken);
      if (!existing) {
        await this.createTokenInternal({
          label: 'Initial admin token',
          role: UserRole.ADMIN,
          operatorIds: [],
          maxOperators: 0,
        }, null, plainToken, true);
        logger.info('Admin token registered from .admin-token file');
      } else if (!existing.system) {
        // 迁移：给已有的初始令牌补上 system 标记
        existing.system = true;
        await this.saveConfig();
      }
    } else {
      // 没有 .admin-token 文件，生成新 token
      const result = await this.createTokenInternal({
        label: 'Initial admin token',
        role: UserRole.ADMIN,
        operatorIds: [],
        maxOperators: 0,
      }, null, undefined, true);
      plainToken = result.token;
      // 写入 .admin-token 文件供 Electron 等外部进程读取
      await fs.writeFile(this.adminTokenFilePath, plainToken, 'utf-8');
      logger.info('Admin token generated and written to .admin-token file');
    }

    // 每次启动都打印管理员令牌
    logger.info('');
    logger.info('╔══════════════════════════════════════════════════╗');
    logger.info('║  Admin token:                                    ║');
    logger.info(`║  ${plainToken}`);
    logger.info('╚══════════════════════════════════════════════════╝');
    logger.info('');
  }

  // ===== Token CRUD =====

  private generateToken(): string {
    return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
  }

  private async createTokenInternal(
    req: Omit<CreateTokenRequest, 'expiresAt'> & { expiresAt?: number },
    createdBy: string | null,
    plainToken?: string,
    system?: boolean,
  ): Promise<CreateTokenResponse> {
    const token = plainToken || this.generateToken();
    const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);
    const id = `token-${Date.now()}-${randomBytes(4).toString('hex')}`;

    const authToken: AuthToken = {
      id,
      tokenHash,
      label: req.label,
      role: req.role,
      operatorIds: req.operatorIds,
      createdBy,
      createdAt: Date.now(),
      expiresAt: req.expiresAt,
      revoked: false,
      ...(system ? { system: true } : {}),
      ...(req.maxOperators !== undefined ? { maxOperators: req.maxOperators } : {}),
    };

    this.config.tokens.push(authToken);
    await this.saveConfig();

    return {
      id,
      token,
      label: req.label,
      role: req.role,
      operatorIds: req.operatorIds,
      maxOperators: authToken.maxOperators,
    };
  }

  async createToken(req: CreateTokenRequest, createdBy: string | null): Promise<CreateTokenResponse> {
    return this.createTokenInternal(req, createdBy);
  }

  async validateToken(plainToken: string): Promise<AuthToken | null> {
    for (const token of this.config.tokens) {
      if (token.revoked) continue;
      if (token.expiresAt && token.expiresAt < Date.now()) continue;

      const match = await bcrypt.compare(plainToken, token.tokenHash);
      if (match) {
        // 更新 lastUsedAt
        token.lastUsedAt = Date.now();
        this.saveConfig().catch(() => {}); // 不阻塞
        return token;
      }
    }
    return null;
  }

  private async findTokenByPlainText(plainToken: string): Promise<AuthToken | null> {
    for (const token of this.config.tokens) {
      const match = await bcrypt.compare(plainToken, token.tokenHash);
      if (match) return token;
    }
    return null;
  }

  async revokeToken(tokenId: string): Promise<{ success: boolean; error?: string }> {
    const token = this.config.tokens.find(t => t.id === tokenId);
    if (!token) return { success: false, error: 'NOT_FOUND' };
    if (token.system) return { success: false, error: 'SYSTEM_TOKEN' };
    token.revoked = true;
    await this.saveConfig();
    return { success: true };
  }

  /**
   * 重新生成系统令牌：生成新 token 值，替换旧 hash，更新 .admin-token 文件
   */
  async regenerateSystemToken(tokenId: string): Promise<CreateTokenResponse | null> {
    const token = this.config.tokens.find(t => t.id === tokenId);
    if (!token || !token.system) return null;

    const newPlainToken = this.generateToken();
    const newHash = await bcrypt.hash(newPlainToken, BCRYPT_ROUNDS);

    token.tokenHash = newHash;
    token.lastUsedAt = undefined;
    await this.saveConfig();

    // 同步更新 .admin-token 文件
    await fs.writeFile(this.adminTokenFilePath, newPlainToken, 'utf-8');
    logger.info('System token regenerated');

    return {
      id: token.id,
      token: newPlainToken,
      label: token.label,
      role: token.role,
      operatorIds: token.operatorIds,
      maxOperators: token.maxOperators,
    };
  }

  async updateToken(tokenId: string, updates: UpdateTokenRequest): Promise<TokenInfo | null> {
    const token = this.config.tokens.find(t => t.id === tokenId);
    if (!token) return null;

    if (updates.label !== undefined) token.label = updates.label;
    if (updates.role !== undefined) token.role = updates.role;
    if (updates.operatorIds !== undefined) token.operatorIds = updates.operatorIds;
    if (updates.expiresAt !== undefined) {
      token.expiresAt = updates.expiresAt ?? undefined;
    }
    if (updates.maxOperators !== undefined) {
      token.maxOperators = updates.maxOperators ?? undefined; // null → 移除限制
    }

    await this.saveConfig();
    return this.toTokenInfo(token);
  }

  listTokens(): TokenInfo[] {
    return this.config.tokens.map(t => this.toTokenInfo(t));
  }

  getTokenById(tokenId: string): TokenInfo | null {
    const token = this.config.tokens.find(t => t.id === tokenId);
    return token ? this.toTokenInfo(token) : null;
  }

  private toTokenInfo(token: AuthToken): TokenInfo {
    return {
      id: token.id,
      label: token.label,
      role: token.role,
      operatorIds: token.operatorIds,
      createdBy: token.createdBy,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
      lastUsedAt: token.lastUsedAt,
      revoked: token.revoked,
      system: token.system,
      maxOperators: token.maxOperators,
    };
  }

  // ===== JWT =====

  getJwtSecret(): string {
    return this.jwtSecret;
  }

  getJwtExpiresIn(): number {
    return this.config.jwtExpiresInSeconds;
  }

  /**
   * 验证 JWT payload 中引用的 token 是否仍然有效
   */
  isTokenStillValid(tokenId: string): boolean {
    const token = this.config.tokens.find(t => t.id === tokenId);
    if (!token) return false;
    if (token.revoked) return false;
    if (token.expiresAt && token.expiresAt < Date.now()) return false;
    return true;
  }

  /**
   * 获取 token 的最新权限（token 可能被更新过）
   */
  getTokenCurrentPermissions(tokenId: string): { role: UserRole; operatorIds: string[]; maxOperators?: number } | null {
    const token = this.config.tokens.find(t => t.id === tokenId);
    if (!token || token.revoked) return null;
    return { role: token.role, operatorIds: token.operatorIds, maxOperators: token.maxOperators };
  }

  // ===== 认证配置 =====

  isAuthEnabled(): boolean {
    return this.config.enabled;
  }

  isPublicViewingAllowed(): boolean {
    return this.config.allowPublicViewing;
  }

  getAuthConfig() {
    return {
      enabled: this.isAuthEnabled(),
      allowPublicViewing: this.config.allowPublicViewing,
    };
  }

  async updateAuthConfig(updates: UpdateAuthConfigRequest): Promise<{ enabled: boolean; allowPublicViewing: boolean }> {
    if (updates.allowPublicViewing !== undefined) {
      this.config.allowPublicViewing = updates.allowPublicViewing;
    }
    await this.saveConfig();
    logger.info('Auth config updated:', this.getAuthConfig());
    return this.getAuthConfig();
  }

  // ===== 操作员自动分配 =====

  /**
   * 将操作员 ID 加入指定 token 的 operatorIds
   * 用于：用户创建操作员后自动绑定到自己的 token
   */
  async addOperatorToToken(tokenId: string, operatorId: string): Promise<void> {
    const token = this.config.tokens.find(t => t.id === tokenId);
    if (!token) return;
    if (!token.operatorIds.includes(operatorId)) {
      token.operatorIds.push(operatorId);
      await this.saveConfig();
    }
  }

  /**
   * 从所有 token 的 operatorIds 中移除指定操作员 ID
   * 用于：操作员被删除后清理引用
   */
  async removeOperatorFromAllTokens(operatorId: string): Promise<void> {
    let changed = false;
    for (const token of this.config.tokens) {
      const idx = token.operatorIds.indexOf(operatorId);
      if (idx !== -1) {
        token.operatorIds.splice(idx, 1);
        changed = true;
      }
    }
    if (changed) {
      await this.saveConfig();
    }
  }

  /**
   * 检查 token 是否还能添加更多操作员
   * @returns true 表示可以创建，false 表示已达上限
   */
  canAddOperator(tokenId: string): boolean {
    const token = this.config.tokens.find(t => t.id === tokenId);
    if (!token) return false;
    if (token.role === UserRole.ADMIN) return true; // Admin 无限制
    if (token.maxOperators === undefined || token.maxOperators === 0) return true; // 0 或未设置表示不限制
    return token.operatorIds.length < token.maxOperators;
  }

  /**
   * 获取 token 的 maxOperators 限制
   */
  getTokenMaxOperators(tokenId: string): number | undefined {
    const token = this.config.tokens.find(t => t.id === tokenId);
    return token?.maxOperators;
  }

  // ===== 角色权限检查工具 =====

  static hasMinRole(userRole: UserRole, requiredRole: UserRole): boolean {
    return USER_ROLE_LEVEL[userRole] >= USER_ROLE_LEVEL[requiredRole];
  }

  static hasOperatorAccess(userRole: UserRole, operatorIds: string[], operatorId: string): boolean {
    if (userRole === UserRole.ADMIN) return true;
    return operatorIds.includes(operatorId);
  }
}
