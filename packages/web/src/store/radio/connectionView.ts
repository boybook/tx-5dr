import type { ConnectionState } from './types';

export function shouldShowServerStatusPage(connection: ConnectionState): boolean {
  const capacityDenied = connection.accessDenied?.reason === 'capacity_reached'
    || connection.accessDenied?.reason === 'ip_limit_reached';

  return capacityDenied || !connection.wasEverReady;
}
