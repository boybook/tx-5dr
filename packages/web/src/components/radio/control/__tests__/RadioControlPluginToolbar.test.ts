import { describe, expect, it } from 'vitest';
import type { PluginStatus, PluginSystemSnapshot } from '@tx5dr/contracts';

import {
  getRadioControlToolbarEntries,
  resolveRadioToolbarIcon,
} from '../RadioControlPluginToolbar';

function buildPlugin(overrides: Partial<PluginStatus> = {}): PluginStatus {
  return {
    name: 'rotator-control',
    type: 'utility',
    instanceScope: 'global',
    version: '1.0.0',
    isBuiltIn: false,
    loaded: true,
    enabled: true,
    errorCount: 0,
    ui: {
      dir: 'ui',
      pages: [{
        id: 'rotator',
        title: 'Rotator',
        entry: 'rotator.html',
        accessScope: 'operator',
        resourceBinding: 'none',
      }],
    },
    panels: [{
      id: 'rotator-button',
      title: 'Rotator',
      component: 'iframe',
      pageId: 'rotator',
      slot: 'radio-control-toolbar',
      icon: 'satellite-dish',
    }],
    ...overrides,
  };
}

function getEntries(params: {
  plugins: PluginStatus[];
  panelContributions?: PluginSystemSnapshot['panelContributions'];
  canAccessOperator?: boolean;
  canAccessAdmin?: boolean;
}) {
  return getRadioControlToolbarEntries({
    plugins: params.plugins,
    panelContributions: params.panelContributions,
    getMeta: () => ({}),
    canAccessOperator: params.canAccessOperator ?? true,
    canAccessAdmin: params.canAccessAdmin ?? false,
    pluginGeneration: 1,
    initialPanelMeta: [],
  });
}

describe('RadioControlPluginToolbar helpers', () => {
  it('resolves FontAwesome Free solid and brands icons with fallback', () => {
    expect(resolveRadioToolbarIcon('arrows-rotate').iconName).toBe('arrows-rotate');
    expect(resolveRadioToolbarIcon('satellite-dish').iconName).toBe('satellite-dish');
    expect(resolveRadioToolbarIcon('solid:tower-broadcast').iconName).toBe('tower-broadcast');
    expect(resolveRadioToolbarIcon('brands:github').iconName).toBe('github');
    expect(resolveRadioToolbarIcon('faGithub').iconName).toBe('github');
    expect(resolveRadioToolbarIcon('missing-icon-name').iconName).toBe('puzzle-piece');
  });

  it('only returns enabled global utility toolbar iframe panels', () => {
    const entries = getEntries({
      plugins: [
        buildPlugin(),
        buildPlugin({ name: 'disabled-plugin', enabled: false }),
        buildPlugin({ name: 'operator-plugin', instanceScope: 'operator' }),
        buildPlugin({ name: 'strategy-plugin', type: 'strategy', assignedOperatorIds: ['operator-1'] }),
        buildPlugin({
          name: 'wrong-slot',
          panels: [{
            id: 'operator-panel',
            title: 'Operator',
            component: 'iframe',
            pageId: 'rotator',
            slot: 'operator',
          }],
        }),
      ],
    });

    expect(entries.map((entry) => entry.pluginName)).toEqual(['rotator-control']);
    expect(entries[0]?.panelId).toBe('rotator-button');
  });

  it('keeps plugin and panel declaration order', () => {
    const entries = getEntries({
      plugins: [
        buildPlugin({
          name: 'first-plugin',
          panels: [
            {
              id: 'first-a',
              title: 'First A',
              component: 'iframe',
              pageId: 'rotator',
              slot: 'radio-control-toolbar',
            },
            {
              id: 'first-b',
              title: 'First B',
              component: 'iframe',
              pageId: 'rotator',
              slot: 'radio-control-toolbar',
            },
          ],
        }),
        buildPlugin({ name: 'second-plugin' }),
      ],
    });

    expect(entries.map((entry) => `${entry.pluginName}:${entry.panelId}`)).toEqual([
      'first-plugin:first-a',
      'first-plugin:first-b',
      'second-plugin:rotator-button',
    ]);
  });

  it('filters entries by page access scope', () => {
    const adminOnlyPlugin = buildPlugin({
      name: 'admin-plugin',
      ui: {
        dir: 'ui',
        pages: [{
          id: 'rotator',
          title: 'Rotator',
          entry: 'rotator.html',
          accessScope: 'admin',
          resourceBinding: 'none',
        }],
      },
    });

    expect(getEntries({
      plugins: [adminOnlyPlugin],
      canAccessOperator: true,
      canAccessAdmin: false,
    })).toHaveLength(0);
    expect(getEntries({
      plugins: [adminOnlyPlugin],
      canAccessOperator: true,
      canAccessAdmin: true,
    })).toHaveLength(1);
  });

  it('uses global runtime contributions without duplicating manifest groups', () => {
    const panelContributions: PluginSystemSnapshot['panelContributions'] = [
      {
        pluginName: 'rotator-control',
        groupId: 'manifest',
        source: 'manifest',
        panels: buildPlugin().panels ?? [],
      },
      {
        pluginName: 'rotator-control',
        groupId: 'dynamic',
        source: 'runtime',
        instanceTarget: { kind: 'global' },
        panels: [{
          id: 'dynamic-button',
          title: 'Dynamic',
          component: 'iframe',
          pageId: 'rotator',
          slot: 'radio-control-toolbar',
        }],
      },
      {
        pluginName: 'rotator-control',
        groupId: 'operator-dynamic',
        source: 'runtime',
        instanceTarget: { kind: 'operator', operatorId: 'operator-1' },
        panels: [{
          id: 'operator-button',
          title: 'Operator Dynamic',
          component: 'iframe',
          pageId: 'rotator',
          slot: 'radio-control-toolbar',
        }],
      },
    ];

    const entries = getEntries({
      plugins: [buildPlugin()],
      panelContributions,
    });

    expect(entries.map((entry) => entry.panelId)).toEqual(['rotator-button', 'dynamic-button']);
  });
});
