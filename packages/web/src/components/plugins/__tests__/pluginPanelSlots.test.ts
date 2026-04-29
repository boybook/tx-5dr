import { describe, expect, it } from 'vitest';
import type { PluginStatus } from '@tx5dr/contracts';

import { getVisiblePluginPanelsForSlot } from '../pluginPanelSlots';

function buildPlugin(overrides: Partial<PluginStatus> = {}): PluginStatus {
  return {
    name: 'web-iframe-embed',
    type: 'utility',
    version: '1.0.0',
    isBuiltIn: false,
    loaded: true,
    enabled: true,
    errorCount: 0,
    ...overrides,
  };
}

describe('pluginPanelSlots', () => {
  it('merges manifest and runtime panel contributions for the requested slot', () => {
    const entries = getVisiblePluginPanelsForSlot({
      plugins: [buildPlugin({
        panels: [{
          id: 'manifest-panel',
          title: 'Manifest',
          component: 'iframe',
          pageId: 'manifest-page',
          slot: 'voice-right-top',
        }],
      })],
      panelContributions: [{
        pluginName: 'web-iframe-embed',
        groupId: 'voice-tabs',
        source: 'runtime',
        instanceTarget: { kind: 'operator', operatorId: 'operator-1' },
        panels: [
          {
            id: 'voice-right-tab:one',
            title: 'One',
            component: 'iframe',
            pageId: 'voice-right-webview',
            params: { tabId: 'one' },
            slot: 'voice-right-top',
          },
          {
            id: 'voice-right-tab:two',
            title: 'Two',
            component: 'iframe',
            pageId: 'voice-right-webview',
            params: { tabId: 'two' },
            slot: 'voice-right-top',
          },
        ],
      }],
      getMeta: () => ({}),
      operatorId: 'operator-1',
      slot: 'voice-right-top',
      pluginGeneration: 1,
      initialPanelMeta: [],
    });

    expect(entries.map((entry) => entry.panel.id)).toEqual([
      'manifest-panel',
      'voice-right-tab:one',
      'voice-right-tab:two',
    ]);
    expect(entries[1].panel.params).toEqual({ tabId: 'one' });
  });

  it('ignores runtime contributions for another operator', () => {
    const entries = getVisiblePluginPanelsForSlot({
      plugins: [buildPlugin()],
      panelContributions: [{
        pluginName: 'web-iframe-embed',
        groupId: 'voice-tabs',
        source: 'runtime',
        instanceTarget: { kind: 'operator', operatorId: 'operator-2' },
        panels: [{
          id: 'voice-right-tab:other',
          title: 'Other',
          component: 'iframe',
          pageId: 'voice-right-webview',
          slot: 'voice-right-top',
        }],
      }],
      getMeta: () => ({}),
      operatorId: 'operator-1',
      slot: 'voice-right-top',
      pluginGeneration: 1,
      initialPanelMeta: [],
    });

    expect(entries).toEqual([]);
  });
});
