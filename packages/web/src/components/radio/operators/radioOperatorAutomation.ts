import type { PluginStatus } from '@tx5dr/contracts';

export function getActiveTransmitControlPlugins(plugins: PluginStatus[], operatorId: string): PluginStatus[] {
  return plugins.filter((plugin) =>
    (plugin.permissions?.includes('operator:transmit-control') ?? false)
    && (plugin.autoCallEnabledOperatorIds?.includes(operatorId) ?? false)
  );
}

export function hasActiveTransmitControlPlugin(plugins: PluginStatus[], operatorId: string): boolean {
  return getActiveTransmitControlPlugins(plugins, operatorId).length > 0;
}
