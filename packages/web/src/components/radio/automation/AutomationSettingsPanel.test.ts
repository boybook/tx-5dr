import { describe, expect, it } from 'vitest';
import type { PluginStatus } from '@tx5dr/contracts';
import { pluginMatchesAutomationFilter } from './automationFilters';
import {
  getOperatorQuickSettings,
  shouldShowAutomationStrategySelector,
} from './AutomationSettingsPanel';

function createPlugin(
  permissions: PluginStatus['permissions'] = [],
  capabilities: PluginStatus['capabilities'] = [],
): PluginStatus {
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
    permissions,
    capabilities,
  };
}

describe('AutomationSettingsPanel filtering', () => {
  it('keeps all plugins in the default automation panel', () => {
    expect(pluginMatchesAutomationFilter(createPlugin(), 'all')).toBe(true);
  });

  it('keeps only transmit-control plugins in the operator auto-call popover', () => {
    expect(pluginMatchesAutomationFilter(
      createPlugin(['operator:transmit-control'], ['auto_call_control']),
      'transmit-control',
    )).toBe(true);
    expect(pluginMatchesAutomationFilter(
      createPlugin(['network', 'operator:transmit-control']),
      'transmit-control',
    )).toBe(false);
    expect(pluginMatchesAutomationFilter(createPlugin(['network']), 'transmit-control')).toBe(false);
    expect(pluginMatchesAutomationFilter(createPlugin(), 'transmit-control')).toBe(false);
  });

  it('shows the strategy switch only in the main Quick Action panel', () => {
    const strategies: PluginStatus[] = [
      { ...createPlugin(), name: 'standard-qso', type: 'strategy' },
      { ...createPlugin(), name: 'assisted-qso-queue', type: 'strategy' },
    ];

    expect(shouldShowAutomationStrategySelector(strategies, 'all')).toBe(true);
    expect(shouldShowAutomationStrategySelector(strategies, 'transmit-control')).toBe(false);
    expect(shouldShowAutomationStrategySelector(strategies.slice(0, 1), 'all')).toBe(false);
  });

  it('keeps declared operator quick settings for the active strategy group', () => {
    const strategy: PluginStatus = {
      ...createPlugin(),
      name: 'assisted-qso-queue',
      type: 'strategy',
      assignedOperatorIds: ['operator-1'],
      settings: {
        replyToWorkedStations: {
          type: 'boolean',
          default: false,
          label: 'replyToWorkedStations',
          scope: 'operator',
        },
        distinguishWorkedStationsByBand: {
          type: 'boolean',
          default: true,
          label: 'distinguishWorkedStationsByBand',
          scope: 'operator',
        },
        skipTx1: {
          type: 'boolean',
          default: false,
          label: 'skipTx1',
          scope: 'operator',
        },
      },
      quickSettings: [
        { settingKey: 'replyToWorkedStations' },
        { settingKey: 'distinguishWorkedStationsByBand' },
        { settingKey: 'skipTx1' },
      ],
    };

    expect(getOperatorQuickSettings(strategy).map((entry) => entry.settingKey)).toEqual([
      'replyToWorkedStations',
      'distinguishWorkedStationsByBand',
      'skipTx1',
    ]);
  });
});
