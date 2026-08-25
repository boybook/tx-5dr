import type { ConnectionState } from './types';

export function shouldShowServerStatusPage(connection: ConnectionState): boolean {
  const stableDeniedPage = connection.accessDenied?.reason === 'capacity_reached'
    || connection.accessDenied?.reason === 'ip_limit_reached'
    || connection.accessDenied?.reason === 'origin_not_allowed';

  return stableDeniedPage || !connection.wasEverReady;
}
