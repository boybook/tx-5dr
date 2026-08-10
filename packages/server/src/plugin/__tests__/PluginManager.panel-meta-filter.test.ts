import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginPanelMetaPayload } from '@tx5dr/contracts';
import { AuthManager } from '../../auth/AuthManager.js';
import { PluginManager } from '../PluginManager.js';

function mockActivePanelMetaTokens(activeTokenIds: string[]) {
  const activeTokens = new Set(activeTokenIds);
  const authManager = {
    getAuthorizationVersion: vi.fn(() => 1),
    getTokenCurrentPermissions: vi.fn((tokenId: string) => activeTokens.has(tokenId)
      ? { role: 'OPERATOR' as const, operatorIds: [] }
      : null),
  };
  vi.spyOn(AuthManager, 'getInstance').mockReturnValue(authManager as unknown as AuthManager);
  return authManager;
}

function createRawManager() {
  const manager = Object.create(PluginManager.prototype) as PluginManager;
  const rawManager = manager as unknown as {
    panelMetaState: Map<string, PluginPanelMetaPayload>;
    panelMetaTokenIndex: Map<string, Set<string>>;
    panelMetaTokenTouchedAt: Map<string, number>;
    getPanelMetaSnapshot(viewerTokenId?: string): PluginPanelMetaPayload[];
    recordPanelMeta(payload: PluginPanelMetaPayload): void;
    enforcePanelMetaTokenLimit(): void;
  };
  rawManager.panelMetaState = new Map();
  rawManager.panelMetaTokenIndex = new Map();
  rawManager.panelMetaTokenTouchedAt = new Map();
  return { manager, rawManager };
}

describe('PluginManager user-scoped panel meta filtering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns only global entries without a viewer token and narrows scoped entries per token', () => {
    const authManager = mockActivePanelMetaTokens(['token-a', 'token-b']);

    const { rawManager } = createRawManager();

    rawManager.panelMetaTokenIndex = new Map([
      ['token-a', new Set(['demo:__global__:toolbar:token-a'])],
      ['token-b', new Set(['demo:__global__:toolbar:token-b'])],
    ]);
    rawManager.panelMetaTokenTouchedAt = new Map([
      ['token-a', 1],
      ['token-b', 2],
    ]);
    rawManager.panelMetaState = new Map([
      ['demo:__global__:toolbar:*', {
        pluginName: 'demo',
        operatorId: '__global__',
        panelId: 'toolbar',
        meta: { title: 'Base' },
      }],
      ['demo:__global__:toolbar:token-a', {
        pluginName: 'demo',
        operatorId: '__global__',
        panelId: 'toolbar',
        viewerTokenId: 'token-a',
        meta: { tone: 'danger' },
      }],
      ['demo:__global__:toolbar:token-b', {
        pluginName: 'demo',
        operatorId: '__global__',
        panelId: 'toolbar',
        viewerTokenId: 'token-b',
        meta: { tone: 'warning' },
      }],
    ]);

    expect(rawManager.getPanelMetaSnapshot()).toEqual([
      {
        pluginName: 'demo',
        operatorId: '__global__',
        panelId: 'toolbar',
        meta: { title: 'Base' },
      },
    ]);
    expect(rawManager.getPanelMetaSnapshot('token-a')).toEqual([
      {
        pluginName: 'demo',
        operatorId: '__global__',
        panelId: 'toolbar',
        meta: { title: 'Base' },
      },
      {
        pluginName: 'demo',
        operatorId: '__global__',
        panelId: 'toolbar',
        viewerTokenId: 'token-a',
        meta: { tone: 'danger' },
      },
    ]);
    expect(authManager.getTokenCurrentPermissions).toHaveBeenCalledTimes(2);
  });

  it('accumulates panel meta patches and clears user overrides back to global inheritance', () => {
    mockActivePanelMetaTokens(['token-a']);
    const { rawManager } = createRawManager();

    rawManager.recordPanelMeta({
      pluginName: 'demo',
      operatorId: '__global__',
      panelId: 'toolbar',
      meta: { tone: 'danger' },
    });
    rawManager.recordPanelMeta({
      pluginName: 'demo',
      operatorId: '__global__',
      panelId: 'toolbar',
      meta: { title: 'Acked' },
    });
    rawManager.recordPanelMeta({
      pluginName: 'demo',
      operatorId: '__global__',
      panelId: 'toolbar',
      viewerTokenId: 'token-a',
      meta: { tone: 'default' },
    });

    expect(rawManager.getPanelMetaSnapshot('token-a')).toEqual([
      {
        pluginName: 'demo',
        operatorId: '__global__',
        panelId: 'toolbar',
        meta: {
          tone: 'danger',
          title: 'Acked',
        },
      },
      {
        pluginName: 'demo',
        operatorId: '__global__',
        panelId: 'toolbar',
        viewerTokenId: 'token-a',
        meta: { tone: 'default' },
      },
    ]);

    rawManager.recordPanelMeta({
      pluginName: 'demo',
      operatorId: '__global__',
      panelId: 'toolbar',
      viewerTokenId: 'token-a',
      meta: { tone: null },
    });
    rawManager.recordPanelMeta({
      pluginName: 'demo',
      operatorId: '__global__',
      panelId: 'toolbar',
      meta: { tone: 'danger' },
    });

    expect(rawManager.getPanelMetaSnapshot('token-a')).toEqual([
      {
        pluginName: 'demo',
        operatorId: '__global__',
        panelId: 'toolbar',
        meta: {
          tone: 'danger',
          title: 'Acked',
        },
      },
    ]);
    expect(rawManager.panelMetaTokenIndex.has('token-a')).toBe(false);
  });

  it('removes panel meta for inactive tokens during snapshot pruning', () => {
    mockActivePanelMetaTokens(['token-a']);
    const { rawManager } = createRawManager();

    rawManager.panelMetaTokenIndex = new Map([
      ['token-a', new Set(['demo:__global__:toolbar:token-a'])],
      ['token-b', new Set(['demo:__global__:toolbar:token-b'])],
    ]);
    rawManager.panelMetaTokenTouchedAt = new Map([
      ['token-a', 1],
      ['token-b', 2],
    ]);
    rawManager.panelMetaState = new Map([
      ['demo:__global__:toolbar:token-a', {
        pluginName: 'demo',
        operatorId: '__global__',
        panelId: 'toolbar',
        viewerTokenId: 'token-a',
        meta: { tone: 'danger' },
      }],
      ['demo:__global__:toolbar:token-b', {
        pluginName: 'demo',
        operatorId: '__global__',
        panelId: 'toolbar',
        viewerTokenId: 'token-b',
        meta: { tone: 'warning' },
      }],
    ]);

    expect(rawManager.getPanelMetaSnapshot('token-a')).toEqual([
      {
        pluginName: 'demo',
        operatorId: '__global__',
        panelId: 'toolbar',
        viewerTokenId: 'token-a',
        meta: { tone: 'danger' },
      },
    ]);
    expect(rawManager.panelMetaState.has('demo:__global__:toolbar:token-b')).toBe(false);
    expect(rawManager.panelMetaTokenIndex.has('token-b')).toBe(false);
    expect(rawManager.panelMetaTokenTouchedAt.has('token-b')).toBe(false);
  });

  it('fails closed for scoped metadata when AuthManager throws', () => {
    vi.spyOn(AuthManager, 'getInstance').mockImplementation(() => {
      throw new Error('AuthManager not initialized');
    });
    const { rawManager } = createRawManager();
    rawManager.panelMetaTokenIndex.set('token-a', new Set(['scoped']));
    rawManager.panelMetaState.set('global', {
      pluginName: 'demo',
      operatorId: '__global__',
      panelId: 'toolbar',
      meta: { title: 'Base' },
    });
    rawManager.panelMetaState.set('scoped', {
      pluginName: 'demo',
      operatorId: '__global__',
      panelId: 'toolbar',
      viewerTokenId: 'token-a',
      meta: { tone: 'danger' },
    });

    expect(rawManager.getPanelMetaSnapshot()).toEqual([
      {
        pluginName: 'demo',
        operatorId: '__global__',
        panelId: 'toolbar',
        meta: { title: 'Base' },
      },
    ]);
    expect(rawManager.panelMetaTokenIndex).toHaveLength(0);
  });

  it('keeps colon-containing panel metadata keys isolated', () => {
    const { rawManager } = createRawManager();
    rawManager.recordPanelMeta({
      pluginName: 'demo:primary',
      operatorId: 'operator',
      panelId: 'toolbar',
      meta: { title: 'First' },
    });
    rawManager.recordPanelMeta({
      pluginName: 'demo',
      operatorId: 'primary:operator',
      panelId: 'toolbar',
      meta: { title: 'Second' },
    });

    expect(rawManager.getPanelMetaSnapshot()).toEqual([
      {
        pluginName: 'demo:primary',
        operatorId: 'operator',
        panelId: 'toolbar',
        meta: { title: 'First' },
      },
      {
        pluginName: 'demo',
        operatorId: 'primary:operator',
        panelId: 'toolbar',
        meta: { title: 'Second' },
      },
    ]);
  });

  it('emits a null patch when LRU evicts active scoped metadata', () => {
    const { manager, rawManager } = createRawManager();
    const emit = vi.fn();
    (manager as any).deps = { eventEmitter: { emit } };
    for (let index = 0; index <= 500; index += 1) {
      const tokenId = index === 0 ? 'token-oldest' : `token-${index}`;
      const key = `key-${index}`;
      rawManager.panelMetaTokenIndex.set(tokenId, new Set([key]));
      rawManager.panelMetaTokenTouchedAt.set(tokenId, index);
      rawManager.panelMetaState.set(key, {
        pluginName: 'demo',
        operatorId: '__global__',
        panelId: 'toolbar',
        viewerTokenId: tokenId,
        meta: { tone: 'danger' },
      });
    }

    rawManager.enforcePanelMetaTokenLimit();

    expect(rawManager.panelMetaTokenIndex.has('token-oldest')).toBe(false);
    expect(emit).toHaveBeenCalledWith('pluginPanelMeta', {
      pluginName: 'demo',
      operatorId: '__global__',
      panelId: 'toolbar',
      viewerTokenId: 'token-oldest',
      meta: {
        title: null,
        titleValues: null,
        visible: null,
        tone: null,
      },
    });
  });
});
