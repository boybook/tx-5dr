import { randomUUID } from 'node:crypto';
import {
  OBSERVABILITY_NOTICE_VERSION,
  type ObservabilitySettings,
  type ObservabilityStatus,
} from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { SERVER_BUILD_INFO } from '../generated/buildInfo.js';
import { WSServer } from '../websocket/WSServer.js';
import { getDataFilePath, tx5drPaths } from '../utils/app-paths.js';
import { resolveRuntimeDistribution } from '../utils/runtime-distribution.js';
import { JsonFileStore } from '../utils/persistence/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TelemetryService');
const POLL_MS = 15_000;
const HEARTBEAT_MS = 180_000;
const MAX_QUEUE = 200;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PRESENCE_REPLAY_AGE_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_OBSERVABILITY_ENDPOINT = 'https://txdr-obod-decab-snwtlsoajk.cn-hangzhou.fcapp.run';

type TelemetryEventName = 'session_started' | 'presence_snapshot' | 'session_ended';
type TelemetryReason = 'startup' | 'heartbeat' | 'connection_change' | 'shutdown';

interface QueuedEvent {
  event_id: string;
  event_name: TelemetryEventName;
  occurred_at_ms: number;
  session_id: string;
  runtime_state: 'online' | 'offline';
  active_connections: number;
  uptime_seconds: number;
  reason: TelemetryReason;
}

interface PrivateState {
  installationId: string;
  registrationEventId: string;
  token: string | null;
  tokenExpiresAt: number | null;
  queue: QueuedEvent[];
  lastSentAt: number | null;
  lastError: string | null;
}

interface AppMetadata {
  version: string;
  build_channel: 'release' | 'nightly';
  build_commit: string;
  distribution: 'electron' | 'docker' | 'android-bridge' | 'linux-service' | 'generic-server' | 'web-dev';
  os_family: 'win32' | 'darwin' | 'linux' | 'android' | 'other';
  arch: 'x64' | 'arm64' | 'arm' | 'other';
}

function validatePrivateState(value: unknown): PrivateState {
  if (!value || typeof value !== 'object') throw new Error('observability state must be an object');
  const state = value as Partial<PrivateState>;
  return {
    installationId: typeof state.installationId === 'string' ? state.installationId : randomUUID(),
    registrationEventId: typeof state.registrationEventId === 'string' ? state.registrationEventId : randomUUID(),
    token: typeof state.token === 'string' ? state.token : null,
    tokenExpiresAt: typeof state.tokenExpiresAt === 'number' ? state.tokenExpiresAt : null,
    queue: Array.isArray(state.queue) ? state.queue.slice(-MAX_QUEUE) as QueuedEvent[] : [],
    lastSentAt: typeof state.lastSentAt === 'number' ? state.lastSentAt : null,
    lastError: typeof state.lastError === 'string' ? state.lastError : null,
  };
}

function normalizeOsFamily(): AppMetadata['os_family'] {
  if (process.env.TX5DR_RUNTIME_FLAVOR === 'android-bridge') return 'android';
  return ['win32', 'darwin', 'linux'].includes(process.platform)
    ? process.platform as AppMetadata['os_family']
    : 'other';
}

function normalizeArch(): AppMetadata['arch'] {
  return ['x64', 'arm64', 'arm'].includes(process.arch) ? process.arch as AppMetadata['arch'] : 'other';
}

export class TelemetryService {
  private static instance: TelemetryService | null = null;
  private store: JsonFileStore<PrivateState> | null = null;
  private state: PrivateState | null = null;
  private metadata: AppMetadata | null = null;
  private timer: NodeJS.Timeout | null = null;
  private sessionId = randomUUID();
  private startedAt = Date.now();
  private lastObservedConnections = 0;
  private lastPresenceAt = 0;
  private nextAttemptAt = 0;
  private backoffMs = 5_000;
  private flushing: Promise<void> | null = null;

  static getInstance(): TelemetryService {
    TelemetryService.instance ??= new TelemetryService();
    return TelemetryService.instance;
  }

  private get endpoint(): string {
    return (process.env.TX5DR_OBSERVABILITY_ENDPOINT || DEFAULT_OBSERVABILITY_ENDPOINT).replace(/\/$/, '');
  }

  async initialize(): Promise<void> {
    if (!this.store) {
      const filePath = await getDataFilePath('observability-state.json');
      this.store = new JsonFileStore<PrivateState>(filePath, {
        defaultValue: () => validatePrivateState({}),
        validate: validatePrivateState,
        mode: 0o600,
        backups: 2,
        createIfMissing: true,
      });
      this.state = await this.store.load();
      const dataDir = await tx5drPaths.getDataDir();
      this.metadata = {
        version: SERVER_BUILD_INFO.version || 'unknown',
        build_channel: SERVER_BUILD_INFO.channel === 'release' ? 'release' : 'nightly',
        build_commit: SERVER_BUILD_INFO.commitShort || SERVER_BUILD_INFO.commit || 'unknown',
        distribution: resolveRuntimeDistribution(dataDir),
        os_family: normalizeOsFamily(),
        arch: normalizeArch(),
      };
    }
    await this.applySettings();
  }

  getStatus(): ObservabilityStatus {
    const settings = ConfigManager.getInstance().getConfig().observability;
    return {
      settings,
      effectiveEnabled: this.isConsentGranted(settings) && Boolean(this.endpoint),
      noticeRequired: settings.noticeVersion < OBSERVABILITY_NOTICE_VERSION,
      endpointConfigured: Boolean(this.endpoint),
      queueDepth: this.state?.queue.length ?? 0,
      lastSentAt: this.state?.lastSentAt ?? null,
      lastError: this.state?.lastError ?? null,
    };
  }

  async applySettings(): Promise<void> {
    const settings = ConfigManager.getInstance().getConfig().observability;
    if (!this.isConsentGranted(settings) || !this.endpoint) {
      this.stopTimer();
      if (this.state && !settings.enabled) {
        this.state.queue = [];
        await this.persist();
      }
      return;
    }
    if (this.timer) return;
    this.startedAt = Date.now();
    this.sessionId = randomUUID();
    this.lastObservedConnections = this.activeConnections();
    await this.enqueue('session_started', 'startup', this.lastObservedConnections);
    await this.flush().catch(() => undefined);
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref?.();
  }

  async shutdown(): Promise<void> {
    this.stopTimer();
    const settings = ConfigManager.getInstance().getConfig().observability;
    if (!this.isConsentGranted(settings) || !this.endpoint || !this.state) return;
    await this.enqueue('session_ended', 'shutdown', 0);
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, 800)),
    ]).catch(() => undefined);
    await this.store?.flush().catch(() => undefined);
  }

  private isConsentGranted(settings: ObservabilitySettings): boolean {
    const envConsent = process.env.TX5DR_TELEMETRY_CONSENT?.trim().toLowerCase();
    if (envConsent === 'disabled') return false;
    if (envConsent === 'enabled') return true;
    return settings.enabled && settings.noticeVersion >= OBSERVABILITY_NOTICE_VERSION;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const active = this.activeConnections();
    if (active !== this.lastObservedConnections && now - this.lastPresenceAt >= 30_000) {
      this.lastObservedConnections = active;
      await this.enqueue('presence_snapshot', 'connection_change', active);
    } else if (now - this.lastPresenceAt >= HEARTBEAT_MS) {
      await this.enqueue('presence_snapshot', 'heartbeat', active);
    }
    if (now >= this.nextAttemptAt) await this.flush().catch(() => undefined);
  }

  private activeConnections(): number {
    return WSServer.getInstance()?.getCapacityStats().active ?? 0;
  }

  private async enqueue(name: TelemetryEventName, reason: TelemetryReason, activeConnections: number): Promise<void> {
    if (!this.state) return;
    const now = Date.now();
    this.state.queue.push({
      event_id: randomUUID(),
      event_name: name,
      occurred_at_ms: now,
      session_id: this.sessionId,
      runtime_state: name === 'session_ended' ? 'offline' : 'online',
      active_connections: activeConnections,
      uptime_seconds: Math.max(0, Math.floor((now - this.startedAt) / 1000)),
      reason,
    });
    this.state.queue = this.state.queue.slice(-MAX_QUEUE);
    if (name === 'presence_snapshot') this.lastPresenceAt = now;
    await this.persist();
  }

  private async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushInternal().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async flushInternal(): Promise<void> {
    if (!this.state || !this.metadata || this.state.queue.length === 0) return;
    try {
      await this.ensureToken();
      if (!this.state.token) return;
      const now = Date.now();
      this.state.queue = this.state.queue.filter((event) => {
        const age = now - event.occurred_at_ms;
        return age <= MAX_EVENT_AGE_MS
          && (event.event_name !== 'presence_snapshot' || age <= MAX_PRESENCE_REPLAY_AGE_MS);
      });
      if (this.state.queue.length === 0) {
        await this.persist();
        return;
      }
      const events = this.state.queue.slice(0, 20);
      const response = await this.post('/v1/telemetry/events', {
        schema_version: 1,
        app: this.metadata,
        events,
      }, this.state.token);
      if (response.status === 401) {
        this.state.token = null;
        this.state.tokenExpiresAt = null;
        throw new Error('unauthorized');
      }
      if (!response.ok) throw new Error(`gateway_${response.status}`);
      this.state.queue.splice(0, events.length);
      this.state.lastSentAt = now;
      this.state.lastError = null;
      this.backoffMs = 5_000;
      this.nextAttemptAt = 0;
      await this.persist();
    } catch (error) {
      const kind = error instanceof Error ? error.message : 'unknown';
      this.state.lastError = kind;
      this.nextAttemptAt = Date.now() + Math.floor(Math.random() * this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 15 * 60 * 1000);
      await this.persist();
      logger.debug('telemetry delivery deferred', { error: kind });
    }
  }

  private async ensureToken(): Promise<void> {
    if (!this.state || !this.metadata) return;
    if (this.state.token && (this.state.tokenExpiresAt ?? 0) > Date.now() + TOKEN_REFRESH_MARGIN_MS) return;
    const response = await this.post('/v1/installations/register', {
      schema_version: 1,
      registration_event_id: this.state.registrationEventId,
      installation_id: this.state.installationId,
      app: this.metadata,
    });
    if (!response.ok) throw new Error(`registration_${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.installation_token !== 'string' || typeof body.token_expires_at !== 'string') {
      throw new Error('invalid_registration_response');
    }
    this.state.token = body.installation_token;
    this.state.tokenExpiresAt = Date.parse(body.token_expires_at);
    this.state.registrationEventId = randomUUID();
    await this.persist();
  }

  private post(path: string, body: unknown, token?: string): Promise<Response> {
    return fetch(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
  }

  private async persist(): Promise<void> {
    if (this.state) await this.store?.set(this.state);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
