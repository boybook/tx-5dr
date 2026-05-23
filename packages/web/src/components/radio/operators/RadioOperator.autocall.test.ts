import { describe, expect, it } from 'vitest';
import type { PluginStatus } from '@tx5dr/contracts';
import {
  getActiveTransmitControlPlugins,
  getPausedTransmitControlPlugins,
  hasActiveTransmitControlPlugin,
} from './radioOperatorAutomation';

function createPlugin(overrides: Partial<PluginStatus>): PluginStatus {
  return {
    name: 'test-plugin',
    type: 'utility',
    version: '1.0.0',
    isBuiltIn: false,
    loaded: true,
    enabled: true,
    instanceScope: 'operator',
    autoDisabled: false,
    errorCount: 0,
    permissions: [],
    ...overrides,
  };
}

describe('RadioOperator auto-call indicator', () => {
  it('turns on only for transmit-control plugins enabled for the operator', () => {
    expect(hasActiveTransmitControlPlugin([
      createPlugin({
        permissions: ['operator:transmit-control'],
        autoCallEnabledOperatorIds: ['operator-1'],
      }),
    ], 'operator-1')).toBe(true);

    expect(hasActiveTransmitControlPlugin([
      createPlugin({
        permissions: ['operator:transmit-control'],
        autoCallEnabledOperatorIds: ['operator-2'],
      }),
    ], 'operator-1')).toBe(false);

    expect(hasActiveTransmitControlPlugin([
      createPlugin({
        permissions: ['network'],
        autoCallEnabledOperatorIds: ['operator-1'],
      }),
    ], 'operator-1')).toBe(false);
  });

  it('returns active transmit-control plugin list for summaries', () => {
    const activePlugin = createPlugin({
      name: 'active-autocall',
      permissions: ['operator:transmit-control'],
      autoCallEnabledOperatorIds: ['operator-1'],
    });
    const plugins = [
      activePlugin,
      createPlugin({
        name: 'other-operator',
        permissions: ['operator:transmit-control'],
        autoCallEnabledOperatorIds: ['operator-2'],
      }),
      createPlugin({
        name: 'no-permission',
        permissions: ['network'],
        autoCallEnabledOperatorIds: ['operator-1'],
      }),
    ];

    expect(getActiveTransmitControlPlugins(plugins, 'operator-1')).toEqual([activePlugin]);
  });

  it('excludes paused transmit-control plugins from active summaries', () => {
    const pausedPlugin = createPlugin({
      name: 'paused-autocall',
      permissions: ['operator:transmit-control'],
      autoCallEnabledOperatorIds: ['operator-1'],
      pausedOperatorIds: ['operator-1'],
    });

    expect(getActiveTransmitControlPlugins([pausedPlugin], 'operator-1')).toEqual([]);
    expect(hasActiveTransmitControlPlugin([pausedPlugin], 'operator-1')).toBe(false);
    expect(getPausedTransmitControlPlugins([pausedPlugin], 'operator-1')).toEqual([pausedPlugin]);
  });
});
