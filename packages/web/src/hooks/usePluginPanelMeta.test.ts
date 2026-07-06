import { describe, expect, it } from 'vitest';
import type { PluginPanelMetaPayload } from '@tx5dr/contracts';
import { buildPanelMetaLayers } from './usePluginPanelMeta';

describe('buildPanelMetaLayers', () => {
  it('keeps global and user-scoped panel meta in separate layers', () => {
    const entries: PluginPanelMetaPayload[] = [
      {
        pluginName: 'operator-live-chat',
        operatorId: '__global__',
        panelId: 'chat-toolbar',
        meta: {
          title: 'OP Chat',
          tone: 'danger',
        },
      },
      {
        pluginName: 'operator-live-chat',
        operatorId: '__global__',
        panelId: 'chat-toolbar',
        viewerTokenId: 'token-1',
        meta: {
          tone: 'default',
        },
      },
    ];

    const layers = buildPanelMetaLayers(entries);
    const key = 'operator-live-chat:__global__:chat-toolbar';

    expect(layers.globalMetaMap[key]).toEqual({
      title: 'OP Chat',
      tone: 'danger',
    });
    expect(layers.scopedMetaMap[key]).toEqual({
      tone: 'default',
    });
    expect({
      ...layers.globalMetaMap[key],
      ...layers.scopedMetaMap[key],
    }).toEqual({
      title: 'OP Chat',
      tone: 'default',
    });
  });
});
