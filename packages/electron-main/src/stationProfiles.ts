import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Persisted station list of the desktop shell.
 *
 * The embedded station always exists and is not stored. Remote stations are
 * stored with the loopback gateway port that serves them: the page origin, and
 * therefore the station's browser storage and sign-in, is bound to that port,
 * so it stays fixed for the life of the profile.
 */

export const EMBEDDED_STATION_ID = 'embedded';

/** Loopback ports reserved for remote station gateways. */
export const REMOTE_GATEWAY_PORT_RANGE = { start: 18100, end: 18299 } as const;

export const DEFAULT_REMOTE_STATION_PORT = 8076;

const FingerprintSchema = z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

export const RemoteStationProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{8,64}$/),
  label: z.string().trim().min(1).max(80),
  /** Station Web entrypoint origin, e.g. `http://192.168.1.10:8076`. */
  url: z.string().url(),
  gatewayPort: z.number().int().min(REMOTE_GATEWAY_PORT_RANGE.start).max(REMOTE_GATEWAY_PORT_RANGE.end),
  /** Pinned certificate for an HTTPS station whose certificate the system does not trust. */
  tls: z.object({
    fingerprint256: FingerprintSchema,
    pinnedAt: z.string(),
  }).optional(),
  /** Last identity seen by a successful probe, for display and discovery matching. */
  lastIdentity: z.object({
    instanceId: z.string(),
    hostVersion: z.string(),
    seenAt: z.string(),
  }).optional(),
});
export type RemoteStationProfile = z.infer<typeof RemoteStationProfileSchema>;

export interface StationSettings {
  activeStationId: string;
  profiles: RemoteStationProfile[];
}

export function createDefaultStationSettings(): StationSettings {
  return { activeStationId: EMBEDDED_STATION_ID, profiles: [] };
}

/**
 * Decodes persisted station settings. Invalid profiles are dropped one by one
 * instead of discarding the whole list; an unknown active station falls back to
 * the embedded station.
 */
export function decodeStationSettings(value: unknown): StationSettings {
  if (!value || typeof value !== 'object') return createDefaultStationSettings();
  const raw = value as { activeStationId?: unknown; profiles?: unknown };
  const profiles: RemoteStationProfile[] = [];
  const seenIds = new Set<string>();
  const seenPorts = new Set<number>();
  for (const candidate of Array.isArray(raw.profiles) ? raw.profiles : []) {
    const parsed = RemoteStationProfileSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const normalized = normalizeStationUrl(parsed.data.url);
    if (!normalized.ok) continue;
    if (seenIds.has(parsed.data.id) || seenPorts.has(parsed.data.gatewayPort)) continue;
    seenIds.add(parsed.data.id);
    seenPorts.add(parsed.data.gatewayPort);
    profiles.push({ ...parsed.data, url: normalized.url });
  }
  const activeStationId = typeof raw.activeStationId === 'string'
    && (raw.activeStationId === EMBEDDED_STATION_ID || seenIds.has(raw.activeStationId))
    ? raw.activeStationId
    : EMBEDDED_STATION_ID;
  return { activeStationId, profiles };
}

export type StationUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'unsupported_protocol' | 'has_path_or_credentials' };

/**
 * Normalizes user input to a station origin. A bare host defaults to
 * `http://<host>:8076`, the station's standard Web port.
 */
export function normalizeStationUrl(input: string): StationUrlResult {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return { ok: false, reason: 'empty' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `http://${trimmed}`);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'unsupported_protocol' };
  if (!url.hostname) return { ok: false, reason: 'invalid' };
  if (url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return { ok: false, reason: 'has_path_or_credentials' };
  }
  if (!hasScheme && !url.port) url.port = String(DEFAULT_REMOTE_STATION_PORT);
  return { ok: true, url: url.origin };
}

/** Picks the lowest unused gateway port; `isUsable` lets the caller skip ports already bound. */
export function allocateGatewayPort(
  profiles: readonly RemoteStationProfile[],
  isUsable: (port: number) => boolean = () => true,
  exclude: ReadonlySet<number> = new Set(),
): number {
  const used = new Set(profiles.map(profile => profile.gatewayPort));
  for (let port = REMOTE_GATEWAY_PORT_RANGE.start; port <= REMOTE_GATEWAY_PORT_RANGE.end; port += 1) {
    if (!used.has(port) && !exclude.has(port) && isUsable(port)) return port;
  }
  throw new Error('remote_gateway_port_range_exhausted');
}

export function createRemoteStationProfile(
  input: { label: string; url: string },
  existing: readonly RemoteStationProfile[],
  options: { generateId?: () => string; isPortUsable?: (port: number) => boolean } = {},
): RemoteStationProfile {
  const normalized = normalizeStationUrl(input.url);
  if (!normalized.ok) throw new Error(`invalid_station_url:${normalized.reason}`);
  return RemoteStationProfileSchema.parse({
    id: (options.generateId ?? randomUUID)(),
    label: input.label.trim() || new URL(normalized.url).host,
    url: normalized.url,
    gatewayPort: allocateGatewayPort(existing, options.isPortUsable),
  });
}

export function findRemoteStation(settings: StationSettings, id: string): RemoteStationProfile | null {
  return settings.profiles.find(profile => profile.id === id) ?? null;
}

export function upsertRemoteStation(settings: StationSettings, profile: RemoteStationProfile): StationSettings {
  const parsed = RemoteStationProfileSchema.parse(profile);
  const index = settings.profiles.findIndex(item => item.id === parsed.id);
  const profiles = [...settings.profiles];
  if (index === -1) profiles.push(parsed);
  else profiles[index] = parsed;
  return { ...settings, profiles };
}

export function removeRemoteStation(settings: StationSettings, id: string): StationSettings {
  return {
    activeStationId: settings.activeStationId === id ? EMBEDDED_STATION_ID : settings.activeStationId,
    profiles: settings.profiles.filter(profile => profile.id !== id),
  };
}

/** Partition holding one remote station's browser storage (sign-in, preferences). */
export function stationPartition(profile: Pick<RemoteStationProfile, 'id'>): string {
  return `persist:station-${profile.id}`;
}

export function gatewayOrigin(profile: Pick<RemoteStationProfile, 'gatewayPort'>): string {
  return `http://127.0.0.1:${profile.gatewayPort}`;
}
