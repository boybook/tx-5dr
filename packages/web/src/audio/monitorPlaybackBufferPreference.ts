export type MonitorPlaybackBufferProfile = 'auto' | 'custom';

export type MonitorPlaybackBufferPreference =
  | { profile: 'auto' }
  | { profile: 'custom'; customTargetBufferMs: number };

export interface ResolvedMonitorPlaybackBufferPolicy {
  profile: MonitorPlaybackBufferProfile;
  adaptive: boolean;
  targetBufferMs: number;
  initialTargetMs: number;
  minTargetMs: number;
  maxTargetMs: number;
  queueHeadroomMs: number;
  targetIncreaseMs: number;
  targetDecreaseMs: number;
  underrunRecoveryFrames: number;
  adaptIncreaseCooldownMs: number;
  adaptDecreaseAfterMs: number;
  adaptDecreaseCooldownMs: number;
}

export const MONITOR_PLAYBACK_BUFFER_STORAGE_KEY = 'tx5dr.monitor.playbackBufferPreference';
export const MONITOR_PLAYBACK_JITTER_SEED_STORAGE_KEY = 'tx5dr.monitor.playbackJitterSeed';
export const MONITOR_PLAYBACK_JITTER_SEED_TTL_MS = 30 * 60 * 1000;
export const MONITOR_PLAYBACK_BUFFER_CUSTOM_MIN_MS = 40;
export const MONITOR_PLAYBACK_BUFFER_CUSTOM_MAX_MS = 500;
export const MONITOR_PLAYBACK_BUFFER_CUSTOM_STEP_MS = 10;
export const DEFAULT_MONITOR_PLAYBACK_BUFFER_PREFERENCE: MonitorPlaybackBufferPreference = { profile: 'auto' };

export const DEFAULT_MONITOR_PLAYBACK_BUFFER_POLICY: ResolvedMonitorPlaybackBufferPolicy = {
  profile: 'auto',
  adaptive: true,
  targetBufferMs: 80,
  initialTargetMs: 80,
  minTargetMs: 60,
  maxTargetMs: 400,
  queueHeadroomMs: 20,
  targetIncreaseMs: 15,
  targetDecreaseMs: 5,
  underrunRecoveryFrames: 3,
  adaptIncreaseCooldownMs: 2500,
  adaptDecreaseAfterMs: 10000,
  adaptDecreaseCooldownMs: 15000,
};

export function clampMonitorPlaybackBufferTarget(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MONITOR_PLAYBACK_BUFFER_POLICY.targetBufferMs;
  }
  return Math.max(
    MONITOR_PLAYBACK_BUFFER_CUSTOM_MIN_MS,
    Math.min(MONITOR_PLAYBACK_BUFFER_CUSTOM_MAX_MS, Math.round(value)),
  );
}

export function normalizeMonitorPlaybackBufferPreference(value: unknown): MonitorPlaybackBufferPreference {
  if (!value || typeof value !== 'object') {
    return DEFAULT_MONITOR_PLAYBACK_BUFFER_PREFERENCE;
  }

  const profile = (value as { profile?: unknown }).profile;
  if (profile === 'custom') {
    const rawTarget = (value as { customTargetBufferMs?: unknown }).customTargetBufferMs;
    const parsedTarget = typeof rawTarget === 'string'
      ? Number.parseInt(rawTarget, 10)
      : Number(rawTarget);
    return {
      profile: 'custom',
      customTargetBufferMs: clampMonitorPlaybackBufferTarget(parsedTarget),
    };
  }

  return DEFAULT_MONITOR_PLAYBACK_BUFFER_PREFERENCE;
}

export function resolveMonitorPlaybackBufferPolicy(
  preference?: MonitorPlaybackBufferPreference | null,
  options?: { initialTargetMs?: number | null },
): ResolvedMonitorPlaybackBufferPolicy {
  const normalized = normalizeMonitorPlaybackBufferPreference(preference);
  if (normalized.profile !== 'custom') {
    const seededInitial = clampAutoInitialTarget(options?.initialTargetMs);
    return {
      ...DEFAULT_MONITOR_PLAYBACK_BUFFER_POLICY,
      targetBufferMs: DEFAULT_MONITOR_PLAYBACK_BUFFER_POLICY.targetBufferMs,
      initialTargetMs: seededInitial,
    };
  }

  const target = clampMonitorPlaybackBufferTarget(normalized.customTargetBufferMs);
  return {
    ...DEFAULT_MONITOR_PLAYBACK_BUFFER_POLICY,
    profile: 'custom',
    adaptive: false,
    targetBufferMs: target,
    initialTargetMs: target,
    minTargetMs: target,
    maxTargetMs: target,
  };
}

export function loadMonitorPlaybackBufferPreference(): MonitorPlaybackBufferPreference {
  if (typeof window === 'undefined') {
    return DEFAULT_MONITOR_PLAYBACK_BUFFER_PREFERENCE;
  }

  try {
    const raw = window.localStorage.getItem(MONITOR_PLAYBACK_BUFFER_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_MONITOR_PLAYBACK_BUFFER_PREFERENCE;
    }
    return normalizeMonitorPlaybackBufferPreference(JSON.parse(raw));
  } catch {
    return DEFAULT_MONITOR_PLAYBACK_BUFFER_PREFERENCE;
  }
}

export function saveMonitorPlaybackBufferPreference(preference: MonitorPlaybackBufferPreference): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(
    MONITOR_PLAYBACK_BUFFER_STORAGE_KEY,
    JSON.stringify(normalizeMonitorPlaybackBufferPreference(preference)),
  );
}

export interface MonitorPlaybackJitterSeed {
  targetMs: number;
  p95Ms: number | null;
  transport: string | null;
  codec: string | null;
  updatedAtMs: number;
}

export function clampAutoInitialTarget(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MONITOR_PLAYBACK_BUFFER_POLICY.initialTargetMs;
  }
  return Math.max(
    DEFAULT_MONITOR_PLAYBACK_BUFFER_POLICY.minTargetMs,
    Math.min(DEFAULT_MONITOR_PLAYBACK_BUFFER_POLICY.maxTargetMs, Math.round(parsed)),
  );
}

export function normalizeMonitorPlaybackJitterSeed(value: unknown, nowMs = Date.now()): MonitorPlaybackJitterSeed | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Partial<MonitorPlaybackJitterSeed>;
  const targetMs = Number(raw.targetMs);
  const updatedAtMs = Number(raw.updatedAtMs);
  if (!Number.isFinite(targetMs) || !Number.isFinite(updatedAtMs)) {
    return null;
  }
  if ((nowMs - updatedAtMs) > MONITOR_PLAYBACK_JITTER_SEED_TTL_MS) {
    return null;
  }
  const p95Ms = Number(raw.p95Ms);
  return {
    targetMs: resolveMonitorPlaybackJitterSeedTargetMs({
      targetMs,
      p95Ms: Number.isFinite(p95Ms) ? p95Ms : null,
    }),
    p95Ms: Number.isFinite(p95Ms) ? Math.max(0, Math.round(p95Ms)) : null,
    transport: typeof raw.transport === 'string' ? raw.transport : null,
    codec: typeof raw.codec === 'string' ? raw.codec : null,
    updatedAtMs: Math.round(updatedAtMs),
  };
}

export function loadMonitorPlaybackJitterSeed(): MonitorPlaybackJitterSeed | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(MONITOR_PLAYBACK_JITTER_SEED_STORAGE_KEY);
    return raw ? normalizeMonitorPlaybackJitterSeed(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveMonitorPlaybackJitterSeed(seed: Omit<MonitorPlaybackJitterSeed, 'updatedAtMs'> & { updatedAtMs?: number }): void {
  if (typeof window === 'undefined') {
    return;
  }
  const normalized = normalizeMonitorPlaybackJitterSeed({
    ...seed,
    updatedAtMs: seed.updatedAtMs ?? Date.now(),
  });
  if (!normalized) {
    return;
  }
  window.localStorage.setItem(MONITOR_PLAYBACK_JITTER_SEED_STORAGE_KEY, JSON.stringify(normalized));
}

export function resolveMonitorPlaybackJitterSeedTargetMs(
  stats: { targetMs: number; p95Ms?: number | null },
): number {
  if (stats.p95Ms === null || stats.p95Ms === undefined) {
    return clampAutoInitialTarget(stats.targetMs);
  }
  const p95Ms = Number(stats.p95Ms);
  if (!Number.isFinite(p95Ms)) {
    return clampAutoInitialTarget(stats.targetMs);
  }
  const p95Recommended = Math.ceil((60 + Math.max(0, p95Ms) + 10) / 20) * 20;
  return Math.min(
    clampAutoInitialTarget(stats.targetMs),
    clampAutoInitialTarget(Math.max(DEFAULT_MONITOR_PLAYBACK_BUFFER_POLICY.initialTargetMs, p95Recommended)),
  );
}
