import path from 'path';
import { normalizeCallsign } from './callsign.js';
import type { PluginUIInstanceTarget } from '../helpers.js';

export interface PluginPageBoundResource {
  kind: 'callsign' | 'operator';
  value: string;
}

function toSafeSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function getInstanceScopeSegments(instanceTarget: PluginUIInstanceTarget): string[] {
  if (instanceTarget.kind === 'global') {
    return ['global'];
  }

  return ['operators', toSafeSegment(instanceTarget.operatorId)];
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

export function getPluginPageStorePath(
  pageId: string,
  scope: {
    instanceTarget: PluginUIInstanceTarget;
    resource?: PluginPageBoundResource | null;
  },
): string {
  return path.posix.join(
    'page-resources',
    'instances',
    ...getInstanceScopeSegments(scope.instanceTarget),
    'resources',
    ...getPluginPageScopeSegments(scope.resource),
    toSafeSegment(pageId),
    'store.json',
  );
}

export function getPluginPageFileScopePath(
  pageId: string,
  scope: {
    instanceTarget: PluginUIInstanceTarget;
    resource?: PluginPageBoundResource | null;
  },
): string {
  return path.posix.join(
    'page-resources',
    'instances',
    ...getInstanceScopeSegments(scope.instanceTarget),
    'resources',
    ...getPluginPageScopeSegments(scope.resource),
    toSafeSegment(pageId),
  );
}
