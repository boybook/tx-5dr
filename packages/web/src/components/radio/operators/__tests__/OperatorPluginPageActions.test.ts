import { describe, expect, it } from 'vitest';
import type { PluginStatus, PluginSystemSnapshot } from '@tx5dr/contracts';
import { resolveOperatorPluginPageActions } from '../OperatorPluginPageActions';

function buildStrategy(overrides: Partial<PluginStatus> = {}): PluginStatus {
  return {
    name: 'ww-digi',
    type: 'strategy',
    instanceScope: 'operator',
    version: '1.0.0',
    isBuiltIn: true,
    loaded: true,
    enabled: true,
    autoDisabled: false,
    errorCount: 0,
    assignedOperatorIds: ['operator-a', 'operator-b'],
    ui: {
      dir: 'ui',
      pages: [{
        id: 'contest-log',
        title: 'Contest log',
        entry: 'contest-log.html',
        accessScope: 'operator',
        resourceBinding: 'operator',
      }],
    },
    panels: [{
      id: 'contest-log',
      title: 'Contest log',
      component: 'iframe',
      pageId: 'contest-log',
      slot: 'operator-action',
      openMode: 'page',
      icon: 'file-lines',
    }],
    ...overrides,
  };
}

function resolve(snapshot: PluginSystemSnapshot, operatorId: string, visible = true) {
  return resolveOperatorPluginPageActions({
    snapshot,
    operatorId,
    canAccessOperator: true,
    canAccessAdmin: false,
    getMeta: () => ({ visible }),
  });
}

describe('operator plugin page actions', () => {
  it('projects the page action only into assigned operator cards', () => {
    const snapshot: PluginSystemSnapshot = {
      state: 'ready',
      generation: 1,
      plugins: [buildStrategy()],
      panelMeta: [],
      panelContributions: [],
    };

    expect(resolve(snapshot, 'operator-a')).toEqual([expect.objectContaining({
      pluginName: 'ww-digi',
      panelId: 'contest-log',
      pageId: 'contest-log',
      title: 'Contest log',
      icon: 'file-lines',
    })]);
    expect(resolve(snapshot, 'operator-b')).toHaveLength(1);
    expect(resolve(snapshot, 'operator-c')).toHaveLength(0);
  });

  it('requires operator page binding and respects panel visibility', () => {
    const unbound = buildStrategy({
      ui: {
        dir: 'ui',
        pages: [{
          id: 'contest-log',
          title: 'Contest log',
          entry: 'contest-log.html',
          accessScope: 'operator',
          resourceBinding: 'none',
        }],
      },
    });
    const snapshot: PluginSystemSnapshot = {
      state: 'ready',
      generation: 1,
      plugins: [unbound],
      panelMeta: [],
      panelContributions: [],
    };

    expect(resolve(snapshot, 'operator-a')).toHaveLength(0);
    expect(resolve({ ...snapshot, plugins: [buildStrategy()] }, 'operator-a', false)).toHaveLength(0);
  });

  it('filters entries by page access scope', () => {
    const adminPage = buildStrategy({
      ui: {
        dir: 'ui',
        pages: [{
          id: 'contest-log',
          title: 'Contest log',
          entry: 'contest-log.html',
          accessScope: 'admin',
          resourceBinding: 'operator',
        }],
      },
    });
    const snapshot: PluginSystemSnapshot = {
      state: 'ready',
      generation: 1,
      plugins: [adminPage],
      panelMeta: [],
      panelContributions: [],
    };

    expect(resolve(snapshot, 'operator-a')).toHaveLength(0);
    expect(resolveOperatorPluginPageActions({
      snapshot,
      operatorId: 'operator-a',
      canAccessOperator: true,
      canAccessAdmin: true,
      getMeta: () => ({}),
    })).toHaveLength(1);
  });
});
