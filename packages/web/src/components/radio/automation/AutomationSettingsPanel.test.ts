import { describe, expect, it } from 'vitest';
import type { PluginStatus } from '@tx5dr/contracts';
import { pluginMatchesAutomationFilter } from './automationFilters';

function createPlugin(permissions: PluginStatus['permissions'] = []): PluginStatus {
  return {
    name: 'test-plugin',
    type: 'utility',
    version: '1.0.0',
    isBuiltIn: false,
    loaded: true,
    enabled: true,
    errorCount: 0,
    permissions,
  };
}

describe('AutomationSettingsPanel filtering', () => {
  it('keeps all plugins in the default automation panel', () => {
    expect(pluginMatchesAutomationFilter(createPlugin(), 'all')).toBe(true);
  });

  it('keeps only transmit-control plugins in the operator auto-call popover', () => {
    expect(pluginMatchesAutomationFilter(createPlugin(['operator:transmit-control']), 'transmit-control')).toBe(true);
    expect(pluginMatchesAutomationFilter(createPlugin(['network']), 'transmit-control')).toBe(false);
    expect(pluginMatchesAutomationFilter(createPlugin(), 'transmit-control')).toBe(false);
  });
});
