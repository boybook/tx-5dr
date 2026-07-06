import { describe, expect, it } from 'vitest';
import type { PluginPanelMetaPayload } from '@tx5dr/contracts';
import { PluginManager } from '../PluginManager.js';

describe('PluginManager user-scoped panel meta filtering', () => {
  it('returns all entries without a viewer filter and narrows user-scoped entries per token', () => {
    const manager = Object.create(PluginManager.prototype) as PluginManager;
    const rawManager = manager as unknown as {
      panelMetaState: Map<string, PluginPanelMetaPayload>;
      getPanelMetaSnapshot(viewerTokenId?: string): PluginPanelMetaPayload[];
    };

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

    expect(rawManager.getPanelMetaSnapshot()).toHaveLength(3);
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
});
