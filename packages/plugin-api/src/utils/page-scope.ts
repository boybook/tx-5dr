import path from 'path';
import { normalizeCallsign } from './callsign.js';

export interface PluginPageBoundResource {
  kind: 'callsign' | 'operator';
  value: string;
}

function toSafeSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

export function getPluginPageScopeSegments(
  resource?: PluginPageBoundResource | null,
): string[] {
  if (!resource) {
    return ['global'];
  }

  if (resource.kind === 'callsign') {
    return ['callsigns', toSafeSegment(normalizeCallsign(resource.value))];
  }

  return ['operators', toSafeSegment(resource.value)];
}

export function getPluginPageScopePath(
  resource?: PluginPageBoundResource | null,
): string {
  return path.posix.join(...getPluginPageScopeSegments(resource));
}
