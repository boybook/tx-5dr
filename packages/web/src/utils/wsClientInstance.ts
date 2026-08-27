import { createLogger } from './logger';
import { createPrefixedClientId } from './clientId';

const logger = createLogger('WSClientInstance');

const SESSION_STORAGE_KEY = 'tx5dr_ws_client_instance_id';

function createInstanceId(): string {
  const prefix = window.location.pathname.includes('spectrum') ? 'spectrum' : 'main';
  return createPrefixedClientId(prefix);
}

export function getWebSocketClientInstanceId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) {
      return existing;
    }

    const created = createInstanceId();
    sessionStorage.setItem(SESSION_STORAGE_KEY, created);
    logger.info('Created WebSocket client instance id', { clientInstanceId: created });
    return created;
  } catch (error) {
    const fallback = createInstanceId();
    logger.warn('Falling back to ephemeral WebSocket client instance id', error);
    return fallback;
  }
}
