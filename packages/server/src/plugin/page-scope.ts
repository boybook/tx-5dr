import path from 'path';
import type { PluginUIInstanceTarget } from '@tx5dr/plugin-api';

// Re-export from plugin-api for backward compatibility
export {
  getPluginPageScopePath,
  getPluginPageScopeSegments,
} from '@tx5dr/plugin-api';
export type { PluginPageBoundResource } from '@tx5dr/plugin-api';

import { getPluginPageScopeSegments } from '@tx5dr/plugin-api';
import type { PluginPageBoundResource } from '@tx5dr/plugin-api';

function toSafeSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function getInstanceScopeSegments(instanceTarget: PluginUIInstanceTarget): string[] {
  if (instanceTarget.kind === 'global') {
    return ['global'];
  }
  return ['operators', toSafeSegment(instanceTarget.operatorId)];
}

export function getPluginPageStorePath(
  pageId: string,
  scope: {
    instanceTarget: PluginUIInstanceTarget;
    resource?: PluginPageBoundResource | null;
  },
): string {
  return path.join(
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
