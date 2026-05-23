import { describe, expect, it } from 'vitest';
import type { PluginStatus } from '@tx5dr/contracts';
import { getActiveTransmitControlPlugins, hasActiveTransmitControlPlugin } from './radioOperatorAutomation';

function createPlugin(overrides: Partial<PluginStatus>): PluginStatus {
  return {
    name: 'test-plugin',
    type: 'utility',
    version: '1.0.0',
    isBuiltIn: false,
    loaded: true,
    enabled: true,
    errorCount: 0,
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
});
