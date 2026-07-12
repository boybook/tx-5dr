import { describe, expect, it } from 'vitest';
import type { PluginPanelMetaPayload } from '@tx5dr/contracts';
import { PluginManager } from '../PluginManager.js';

describe('PluginManager user-scoped panel meta filtering', () => {
  it('returns all entries without a viewer filter and narrows user-scoped entries per token', () => {
    const manager = Object.create(PluginManager.prototype) as PluginManager;
    const rawManager = manager as unknown as {
      panelMetaState: Map<string, PluginPanelMetaPayload>;
      panelMetaTokenIndex: Map<string, Set<string>>;
      panelMetaTokenTouchedAt: Map<string, number>;
      getPanelMetaSnapshot(viewerTokenId?: string): PluginPanelMetaPayload[];
      recordPanelMeta(payload: PluginPanelMetaPayload): void;
    };

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
  });

  it('accumulates panel meta patches and clears user overrides back to global inheritance', () => {
    const manager = Object.create(PluginManager.prototype) as PluginManager;
    const rawManager = manager as unknown as {
      panelMetaState: Map<string, PluginPanelMetaPayload>;
      panelMetaTokenIndex: Map<string, Set<string>>;
      panelMetaTokenTouchedAt: Map<string, number>;
      getPanelMetaSnapshot(viewerTokenId?: string): PluginPanelMetaPayload[];
      recordPanelMeta(payload: PluginPanelMetaPayload): void;
    };

    rawManager.panelMetaState = new Map();
    rawManager.panelMetaTokenIndex = new Map();
    rawManager.panelMetaTokenTouchedAt = new Map();

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
});
