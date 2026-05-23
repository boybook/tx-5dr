import type { PluginStatus } from '@tx5dr/contracts';

export function isTransmitControlPlugin(plugin: PluginStatus): boolean {
  return plugin.permissions?.includes('operator:transmit-control') ?? false;
}

export function isTransmitControlPluginAutoCallEnabled(plugin: PluginStatus, operatorId: string): boolean {
  return isTransmitControlPlugin(plugin)
    && (plugin.autoCallEnabledOperatorIds?.includes(operatorId) ?? false);
}

export function isTransmitControlPluginPaused(plugin: PluginStatus, operatorId: string): boolean {
  return isTransmitControlPlugin(plugin)
    && (plugin.pausedOperatorIds?.includes(operatorId) ?? false);
}

export function getEligibleTransmitControlPlugins(plugins: PluginStatus[]): PluginStatus[] {
  return plugins.filter(isTransmitControlPlugin);
}

export function getPausedTransmitControlPlugins(plugins: PluginStatus[], operatorId: string): PluginStatus[] {
  return plugins.filter((plugin) =>
    isTransmitControlPluginAutoCallEnabled(plugin, operatorId)
    && isTransmitControlPluginPaused(plugin, operatorId)
  );
}

export function getActiveTransmitControlPlugins(plugins: PluginStatus[], operatorId: string): PluginStatus[] {
  return plugins.filter((plugin) =>
    isTransmitControlPluginAutoCallEnabled(plugin, operatorId)
    && !isTransmitControlPluginPaused(plugin, operatorId)
  );
}

export function hasActiveTransmitControlPlugin(plugins: PluginStatus[], operatorId: string): boolean {
  return getActiveTransmitControlPlugins(plugins, operatorId).length > 0;
}
