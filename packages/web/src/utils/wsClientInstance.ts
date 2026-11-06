import { createLogger } from './logger';
import { createPrefixedClientId } from './clientId';

const logger = createLogger('WSClientInstance');

const SESSION_STORAGE_KEY_PREFIX = 'tx5dr_ws_client_instance_id';

type ClientPageKind = 'main' | 'spectrum';

function getClientPageKind(pathname: string): ClientPageKind {
  return pathname.includes('spectrum') ? 'spectrum' : 'main';
}

/**
 * The server replaces an existing connection that presents the same instance
 * id, so the id must identify one page instance and survive only its reloads.
 * A tab opened with `window.open` starts with a copy of the opener's
 * sessionStorage; scoping the key by page kind keeps a standalone spectrum tab
 * from inheriting, and then displacing, the workspace connection.
 */
export function getWebSocketClientInstanceId(pathname: string = window.location.pathname): string {
  const kind = getClientPageKind(pathname);
  const storageKey = `${SESSION_STORAGE_KEY_PREFIX}:${kind}`;
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) {
      return existing;
    }

    const created = createPrefixedClientId(kind);
    sessionStorage.setItem(storageKey, created);
    logger.info('Created WebSocket client instance id', { clientInstanceId: created });
    return created;
  } catch (error) {
    const fallback = createPrefixedClientId(kind);
    logger.warn('Falling back to ephemeral WebSocket client instance id', error);
    return fallback;
  }
}
