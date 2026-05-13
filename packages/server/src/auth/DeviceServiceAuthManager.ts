import { promises as fs } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  DEVICE_UI_JWT_AUDIENCE,
  DEVICE_UI_JWT_TYPE,
  DeviceUiAuthStateSchema,
  DeviceUiJwtPayloadSchema,
  type DeviceUiAuthSessionState,
  type DeviceUiAuthState,
  type DeviceUiJwtPayload,
  type DeviceUiSessionRequest,
  type DeviceUiSessionResponse,
} from '@tx5dr/contracts';
import { getConfigFilePath } from '../utils/app-paths.js';
import { JsonFileStore, PersistenceCoordinator, safeWriteFile } from '../utils/persistence/index.js';

const DEFAULT_JWT_TTL_SECONDS = 12 * 60 * 60;
const DEVICE_SESSION_TOKEN_PREFIX = 'txdr_device_';
const TOKEN_BYTES = 32;
const JWT_SECRET_BYTES = 64;
const TOKEN_FILE_MODE = 0o600;
const JWT_ALGORITHM = 'HS256';

interface DeviceServiceAuthManagerOptions {
  sessionTokenFilePath?: string;
  stateFilePath?: string;
  jwtTtlSeconds?: number;
  now?: () => number;
}

interface SignDeviceJwtOptions {
  deviceId: string;
  sessionId?: string;
  ttlSeconds?: number;
}

interface VerifiedDeviceSession {
  payload: DeviceUiJwtPayload;
  session: DeviceUiAuthSessionState;
}

export class DeviceServiceAuthManager {
  private static instance: DeviceServiceAuthManager | null = null;

  private readonly jwtTtlSeconds: number;
  private readonly now: () => number;
  private sessionTokenFilePath?: string;
  private stateFilePath?: string;
  private stateStore: JsonFileStore<DeviceUiAuthState> | null = null;
  private state: DeviceUiAuthState | null = null;
  private sessionToken: string | null = null;
  private unregisterPersistence: (() => void) | null = null;

  constructor(options: DeviceServiceAuthManagerOptions = {}) {
    this.sessionTokenFilePath = options.sessionTokenFilePath;
    this.stateFilePath = options.stateFilePath;
    this.jwtTtlSeconds = options.jwtTtlSeconds ?? DEFAULT_JWT_TTL_SECONDS;
    this.now = options.now ?? Date.now;
  }

  static getInstance(): DeviceServiceAuthManager {
    if (!this.instance) {
      this.instance = new DeviceServiceAuthManager();
    }
    return this.instance;
  }

  async initialize(): Promise<void> {
    this.sessionTokenFilePath ??= await getConfigFilePath('.device-ui-token');
    this.stateFilePath ??= await getConfigFilePath('device-ui-auth-state.json');

    await this.ensureSessionToken();
    await this.loadState();

    this.unregisterPersistence?.();
    this.unregisterPersistence = PersistenceCoordinator.getInstance().register({
      name: 'device-ui-auth',
      flush: async () => this.flush(),
    });
  }

  getSessionToken(): string {
    this.ensureInitialized();
    return this.sessionToken!;
  }

  validateSessionToken(candidate: string | null | undefined): boolean {
    this.ensureInitialized();
    if (!candidate || !this.sessionToken) return false;
    return timingSafeStringEqual(candidate, this.sessionToken);
  }

  async createSession(request: DeviceUiSessionRequest): Promise<DeviceUiSessionResponse | null> {
    this.ensureInitialized();
    if (!this.validateSessionToken(request.sessionToken)) {
      return null;
    }

    const signed = await this.signDeviceJwt({ deviceId: request.deviceId });
    return {
      jwt: signed.jwt,
      deviceId: signed.payload.deviceId,
      sessionId: signed.payload.sessionId,
      expiresAt: signed.payload.exp * 1000,
    };
  }

  async signDeviceJwt(options: SignDeviceJwtOptions): Promise<{ jwt: string; payload: DeviceUiJwtPayload }> {
    this.ensureInitialized();
    const nowSeconds = Math.floor(this.now() / 1000);
    const sessionId = options.sessionId ?? this.generateSessionId();
    const ttlSeconds = options.ttlSeconds ?? this.jwtTtlSeconds;
    const payload = DeviceUiJwtPayloadSchema.parse({
      typ: DEVICE_UI_JWT_TYPE,
      aud: DEVICE_UI_JWT_AUDIENCE,
      deviceId: options.deviceId,
      sessionId,
      iat: nowSeconds,
      exp: nowSeconds + ttlSeconds,
    });

    await this.upsertSession({
      sessionId,
      deviceId: payload.deviceId,
      createdAt: payload.iat * 1000,
      expiresAt: payload.exp * 1000,
    });

    return {
      jwt: signJwt(payload, this.getJwtSecret()),
      payload,
    };
  }

  verifyDeviceJwt(token: string): DeviceUiJwtPayload | null {
    this.ensureInitialized();
    const payload = verifyJwt(token, this.getJwtSecret());
    if (!payload) return null;

    const parsed = DeviceUiJwtPayloadSchema.safeParse(payload);
    if (!parsed.success) return null;

    const nowSeconds = Math.floor(this.now() / 1000);
    if (parsed.data.exp <= nowSeconds) return null;
    if (parsed.data.iat > nowSeconds + 60) return null;

    return parsed.data;
  }

  async verifyDeviceSession(token: string): Promise<VerifiedDeviceSession | null> {
    const payload = this.verifyDeviceJwt(token);
    if (!payload) return null;

    const session = this.findActiveSession(payload);
    if (!session) return null;

    session.lastVerifiedAt = this.now();
    await this.saveState({ defer: true });
    return { payload, session: { ...session } };
  }

  isSessionJwtValid(token: string): boolean {
    const payload = this.verifyDeviceJwt(token);
    return payload ? this.findActiveSession(payload) !== null : false;
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    this.ensureInitialized();
    const session = this.state!.sessions.find(item => item.sessionId === sessionId);
    if (!session) return false;
    session.revoked = true;
    await this.saveState();
    return true;
  }

  async flush(): Promise<void> {
    await this.stateStore?.flush();
  }

  private async ensureSessionToken(): Promise<void> {
    if (!this.sessionTokenFilePath) throw new Error('DeviceServiceAuthManager token path is not initialized');

    let token: string | null = null;
    try {
      const content = await fs.readFile(this.sessionTokenFilePath, 'utf-8');
      token = content.trim() || null;
    } catch {
      token = null;
    }

    if (!token) {
      token = this.generateSessionToken();
      await safeWriteFile(this.sessionTokenFilePath, token, { backups: 1, mode: TOKEN_FILE_MODE });
    }

    await fs.chmod(this.sessionTokenFilePath, TOKEN_FILE_MODE).catch(() => undefined);
    this.sessionToken = token;
  }

  private async loadState(): Promise<void> {
    if (!this.stateFilePath) throw new Error('DeviceServiceAuthManager state path is not initialized');

    this.stateStore = new JsonFileStore<DeviceUiAuthState>(this.stateFilePath, {
      defaultValue: () => DeviceUiAuthStateSchema.parse({
        jwtSecret: randomBytes(JWT_SECRET_BYTES).toString('base64url'),
        sessions: [],
        updatedAt: this.now(),
      }),
      validate: (value) => DeviceUiAuthStateSchema.parse(value),
      backups: 3,
      mode: TOKEN_FILE_MODE,
    });
    this.state = this.pruneExpiredSessions(await this.stateStore.load());
    await fs.chmod(this.stateFilePath, TOKEN_FILE_MODE).catch(() => undefined);
    await this.saveState({ internal: true });
  }

  private async upsertSession(session: DeviceUiAuthSessionState): Promise<void> {
    this.ensureInitialized();
    const state = this.state!;
    state.sessions = this.pruneExpiredSessions(state).sessions;
    const existingIndex = state.sessions.findIndex(item => item.sessionId === session.sessionId);
    if (existingIndex === -1) {
      state.sessions.push(session);
    } else {
      state.sessions[existingIndex] = { ...state.sessions[existingIndex], ...session, revoked: false };
    }
    await this.saveState();
  }

  private findActiveSession(payload: DeviceUiJwtPayload): DeviceUiAuthSessionState | null {
    this.ensureInitialized();
    const now = this.now();
    const session = this.state!.sessions.find(item => item.sessionId === payload.sessionId && item.deviceId === payload.deviceId);
    if (!session) return null;
    if (session.revoked) return null;
    if (session.expiresAt <= now) return null;
    return session;
  }

  private pruneExpiredSessions(state: DeviceUiAuthState): DeviceUiAuthState {
    const now = this.now();
    return {
      ...state,
      sessions: state.sessions.filter(session => !session.revoked && session.expiresAt > now),
    };
  }

  private async saveState(options: { defer?: boolean; internal?: boolean } = {}): Promise<void> {
    this.ensureInitialized();
    if (!this.stateStore || !this.state) {
      throw new Error('DeviceServiceAuthManager not initialized');
    }
    if (!options.internal) {
      PersistenceCoordinator.getInstance().assertMutationsAllowed('device-ui-auth');
    }
    this.state.updatedAt = this.now();
    await this.stateStore.set(this.state, options);
  }

  private getJwtSecret(): string {
    this.ensureInitialized();
    return this.state!.jwtSecret;
  }

  private generateSessionToken(): string {
    return DEVICE_SESSION_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
  }

  private generateSessionId(): string {
    return `device-session-${randomBytes(16).toString('hex')}`;
  }

  private ensureInitialized(): void {
    if (!this.sessionToken || !this.state) {
      throw new Error('DeviceServiceAuthManager not initialized');
    }
  }
}

function signJwt(payload: DeviceUiJwtPayload, secret: string): string {
  const header = { alg: JWT_ALGORITHM, typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

function verifyJwt(token: string, secret: string): unknown | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => part.length === 0)) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader);
  if (!isJwtHeader(header)) return null;

  const expectedSignature = createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
  if (!timingSafeStringEqual(encodedSignature, expectedSignature)) return null;

  return decodeJson(encodedPayload);
}

function isJwtHeader(value: unknown): value is { alg: string; typ?: string } {
  return Boolean(value && typeof value === 'object' && (value as { alg?: unknown }).alg === JWT_ALGORITHM);
}

function decodeJson(encoded: string): unknown | null {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
