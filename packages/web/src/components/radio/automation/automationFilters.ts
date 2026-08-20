import type { PluginStatus } from '@tx5dr/contracts';

export type AutomationPanelFilter = 'all' | 'transmit-control';

export function pluginMatchesAutomationFilter(
  plugin: PluginStatus,
  filter: AutomationPanelFilter = 'all',
): boolean {
  if (filter === 'transmit-control') {
    return (plugin.permissions?.includes('operator:transmit-control') ?? false)
      && (plugin.capabilities?.includes('auto_call_control') ?? false);
  }
  return true;
}
