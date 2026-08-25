import {
  normalizeRemoteAccessOrigin,
  type RemoteAccessSecurityStatus,
  type RemoteAccessPreset,
} from '@tx5dr/contracts';

export { normalizeRemoteAccessOrigin } from '@tx5dr/contracts';

export type RemoteAccessValidationError = 'originRequired' | 'originInvalid';

export const REMOTE_ACCESS_PRESET_LIMITS: Record<
  RemoteAccessPreset,
  Pick<RemoteAccessSecurityStatus, 'maxConnections' | 'maxConnectionsPerIp' | 'maxPendingAuth'>
> = {
  local: { maxConnections: 8, maxConnectionsPerIp: 8, maxPendingAuth: 8 },
  lan: { maxConnections: 32, maxConnectionsPerIp: 16, maxPendingAuth: 32 },
  public: { maxConnections: 128, maxConnectionsPerIp: 32, maxPendingAuth: 32 },
};

export function applyRemoteAccessPreset(
  settings: RemoteAccessSecurityStatus,
  preset: RemoteAccessPreset,
): RemoteAccessSecurityStatus {
  return {
    ...settings,
    preset,
    ...REMOTE_ACCESS_PRESET_LIMITS[preset],
    ...(preset === 'local' ? { allowPublicViewing: false } : {}),
  };
}

export function validateRemoteAccessDraft(
  settings: RemoteAccessSecurityStatus | null,
): RemoteAccessValidationError | null {
  if (!settings || settings.preset !== 'public') return null;
  if (settings.allowedOrigins.length === 0 || settings.allowedOrigins.every(value => !value.trim())) {
    return 'originRequired';
  }
  return settings.allowedOrigins.some(value => !normalizeRemoteAccessOrigin(value))
    ? 'originInvalid'
    : null;
}

export function normalizeRemoteAccessOrigins(values: string[]): string[] {
  return [...new Set(values.flatMap(value => {
    const normalized = normalizeRemoteAccessOrigin(value);
    return normalized ? [normalized] : [];
  }))];
}
