/**
 * Browser-side containment for remote station windows.
 *
 * Each remote station renders in its own persistent partition with web security
 * on. Renderer-initiated navigation stays on the station's gateway origin;
 * http(s) links elsewhere open in the system browser; anything else is denied.
 * Permissions are granted only to the gateway origin, and only those the
 * station UI uses.
 */

export type NavigationDecision = 'allow' | 'external' | 'deny';

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function classifyStationNavigation(targetUrl: string, stationOrigin: string): NavigationDecision {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return 'deny';
  }
  if (parsed.origin === originOf(stationOrigin)) return 'allow';
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return 'external';
  return 'deny';
}

/** Permissions the station UI needs: microphone for voice TX, notifications, clipboard and fullscreen. */
const REMOTE_STATION_PERMISSIONS: ReadonlySet<string> = new Set([
  'media',
  'notifications',
  'clipboard-sanitized-write',
  'clipboard-read',
  'fullscreen',
  'speaker-selection',
]);

export function isRemoteStationPermissionAllowed(
  permission: string,
  requestingUrl: string | null | undefined,
  stationOrigin: string,
  mediaTypes: readonly string[] = [],
): boolean {
  if (!REMOTE_STATION_PERMISSIONS.has(permission)) return false;
  if (!requestingUrl || originOf(requestingUrl) !== originOf(stationOrigin)) return false;
  // The station needs audio only; camera capture is never granted.
  if (permission === 'media' && mediaTypes.some(type => type !== 'audio')) return false;
  return true;
}

export interface RemoteStationWebPreferencesInput {
  preload: string;
  partition: string;
  bridgeArguments: string[];
}

export function remoteStationWebPreferences(input: RemoteStationWebPreferencesInput): Electron.WebPreferences {
  return {
    partition: input.partition,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    backgroundThrottling: false,
    preload: input.preload,
    additionalArguments: input.bridgeArguments,
  };
}
